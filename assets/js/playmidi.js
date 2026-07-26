import { 
  ME_NOTEON, ME_NOTEOFF, ME_PITCHWHEEL, ME_MAINVOLUME, ME_PAN, ME_PROGRAM,
  ME_EXPRESSION, ME_SUSTAIN, ME_MODULATION, ME_REVERB, ME_CHORUS,
  ME_EOT, ISDRUMCHANNEL,
  VOICE_FREE, VOICE_ON, VOICE_SUSTAINED, VOICE_OFF, VOICE_DIE,
  MODES_ENVELOPE
} from './types.js';
import { freq_table, bend_fine, bend_coarse } from './tables.js';
import { mix_voice, recompute_envelope, apply_envelope_to_amp } from './mix.js';

const FRACTION_BITS = 12;

function TIM_FSCALE(a, b) {
  return a * (1 << b);
}

function TIM_FSCALENEG(a, b) {
  return a / (1 << b);
}

export function recompute_freq(song, v) {
  const vp = song.voice[v];
  const sign = vp.sample_increment < 0;
  let pb = song.channel[vp.channel].pitchbend;

  if (pb === 0x2000 || pb < 0 || pb > 0x3FFF) {
    vp.frequency = vp.orig_frequency;
  } else {
    pb -= 0x2000;
    if (!song.channel[vp.channel].pitchfactor) {
      let i = Math.floor(pb * song.channel[vp.channel].pitchsens);
      if (pb < 0) i = -i;
      song.channel[vp.channel].pitchfactor = bend_fine[(i >> 5) & 0xFF] * bend_coarse[i >> 13];
    }
    if (pb > 0) {
      vp.frequency = song.channel[vp.channel].pitchfactor * vp.orig_frequency;
    } else {
      vp.frequency = vp.orig_frequency / song.channel[vp.channel].pitchfactor;
    }
  }

  let a = TIM_FSCALE((vp.sample.sample_rate * vp.frequency) / 
                     (vp.sample.root_freq * song.rate), FRACTION_BITS);
  if (sign) a = -a;
  vp.sample_increment = a | 0;
}

export function recompute_amp(song, v) {
  const vp = song.voice[v];
  const tempamp = vp.velocity * song.channel[vp.channel].volume * song.channel[vp.channel].expression;

  // The original C code's scaling is complex. It involves an amplification factor.
  // Here, we combine the MIDI velocity/volume/expression with the sample's
  // own volume and the master volume. The previous division was incorrect and
  // caused severe attenuation. Removing it brings the levels up to an audible range.
  // The C code uses a final amplification factor. We need to normalize the combined
  // MIDI volumes. Dividing by (127*127) brings it into a reasonable float range
  // before being scaled up by AMP_BITS in mix.js.
  // A further division by 127.0 is added to provide more headroom and prevent clipping
  // when multiple loud voices are mixed, bringing it closer to the original C
  // implementation's final output level.
  const base_amp = (tempamp / (127.0 * 127.0)) * vp.sample.volume * song.master_volume;

  if (vp.panning > 60 && vp.panning < 68) {
    vp.panned = 1; // PANNED_CENTER
    vp.left_amp = base_amp; // For CENTER, both L/R will use this source
    vp.right_amp = 0; // Not used for CENTER, but clear it
  } else if (vp.panning < 5) {
    vp.panned = 0; // PANNED_LEFT
    vp.left_amp = base_amp;
    vp.right_amp = 0; // Right amp should be zero
  } else if (vp.panning > 123) {
    vp.panned = 2; // PANNED_RIGHT
    vp.left_amp = base_amp; // The mixer logic expects the value here for PANNED_RIGHT
    vp.right_amp = 0; // It will be ignored, but set to 0 for clarity
  } else {
    vp.panned = 3; // PANNED_MYSTERY
    vp.right_amp = base_amp * vp.panning / 127.0;
    vp.left_amp = base_amp * (127 - vp.panning) / 127.0;
  }
}

export function start_note(song, ev, i) {
  let ip;
  const isDrum = (song.drumchannels & (1 << ev.channel)) !== 0;

  if (isDrum) {
    const drum_set_num = song.channel[ev.channel].program;
    ip = song.drumset[drum_set_num]?.instrument[ev.a];
    if (!ip) {
      if (!window._drumLog) window._drumLog = new Set();
      if (!window._drumLog.has(ev.a)) { 
        console.warn("Drum missing:", ev.a); window._drumLog.add(ev.a); 
      }
      return;
    }
    vp_setup(song, i, ip, ev, isDrum);
  } else {
    ip = song.tonebank[0]?.instrument[song.channel[ev.channel].program];
    if (!ip) {
      if (!window._toneLog) window._toneLog = new Set();
      if (!window._toneLog.has(song.channel[ev.channel].program)) { 
        console.warn("Tone missing:", song.channel[ev.channel].program); 
        window._toneLog.add(song.channel[ev.channel].program); 
      }
      return;
    }
    vp_setup(song, i, ip, ev, isDrum);
  }
}

function vp_setup(song, i, ip, ev, isDrum) {
  if (!ip.sample || !ip.sample[0]) {
    if (!window._sampleLog) { 
      console.warn("Instrument has no samples!", ev); 
      window._sampleLog = true; 
    }
    return;
  }
  
  const f = freq_table[ev.a & 0x7F];
  let sp = ip.sample[0];
  
  for (let j = 0; j < ip.sample.length; j++) {
    if (ip.sample[j] && ip.sample[j].low_freq <= f && ip.sample[j].high_freq >= f) {
      sp = ip.sample[j];
      break;
    }
  }

  const vp = song.voice[i];
  vp.sample = sp;
  
  if (vp.sample.note_to_use) {
    vp.orig_frequency = freq_table[vp.sample.note_to_use];
  } else {
    vp.orig_frequency = f;
  }
  
  vp.frequency = vp.orig_frequency;
  vp.channel = ev.channel;
  vp.note = ev.a;
  vp.velocity = ev.b;
  vp.sample_offset = 0;
  vp.sample_increment = 0;
  vp.status = VOICE_ON;

  // CRITICAL FIX: Reset amplitude values to prevent stale data from previous voice usage.
  vp.left_amp = 0.0;
  vp.right_amp = 0.0;
  vp.right_mix = 0;
  
  if (song.channel[ev.channel].panning !== -1) {
    vp.panning = song.channel[ev.channel].panning;
  } else {
    vp.panning = vp.sample.panning;
  }

  recompute_freq(song, i);
  recompute_amp(song, i);

  if (vp.sample.modes & MODES_ENVELOPE) {
    vp.envelope_stage = 0;
    vp.envelope_volume = 0;
    vp.control_counter = 0;
    recompute_envelope(song, i);
    apply_envelope_to_amp(song, i);
  } else {
    vp.envelope_increment = 0;
    apply_envelope_to_amp(song, i);
  }
}

export function note_on(song, ev) {
  let lowest = -1;
  let lv = 0x7FFFFFFF;

  for (let i = 0; i < song.voices; i++) {
    if (song.voice[i].status === VOICE_FREE) {
      lowest = i;
      break;
    } else if (song.voice[i].status === VOICE_ON && song.voice[i].channel === ev.channel && song.voice[i].note === ev.a) {
      // Found an existing voice playing the same note.
      // Reuse this voice instead of creating a new one.
      start_note(song, ev, i);
      return; // Important: stop here to prevent allocating another voice.
    }
  }

  if (lowest !== -1) {
    start_note(song, ev, lowest);
    return;
  }

  // Find lowest volume to steal
  for (let i = 0; i < song.voices; i++) {
    if (song.voice[i].status !== VOICE_ON && song.voice[i].status !== VOICE_DIE) {
      let v = song.voice[i].left_mix;
      if (song.voice[i].panned === 3 && song.voice[i].right_mix > v) {
        v = song.voice[i].right_mix;
      }
      if (v < lv) {
        lv = v;
        lowest = i;
      }
    }
  }

  if (lowest !== -1) {
    song.voice[lowest].status = VOICE_FREE;
    start_note(song, ev, lowest);
  }
}

export function finish_note(song, i) {
  const vp = song.voice[i];
  if (vp.sample.modes & MODES_ENVELOPE) {
    vp.envelope_stage = 3;
    vp.status = VOICE_OFF;
    recompute_envelope(song, i);
    apply_envelope_to_amp(song, i);
  } else {
    vp.status = VOICE_OFF;
  }
}

export function note_off(song, ev) {
  for (let i = 0; i < song.voices; i++) {
    const vp = song.voice[i];
    if (vp.status === VOICE_ON && vp.channel === ev.channel && vp.note === ev.a) {
      if (song.channel[ev.channel].sustain) {
        vp.status = VOICE_SUSTAINED;
      } else {
        finish_note(song, i);
      }
    }
  }
}

export function do_compute_data(song, count) {
  song.common_buffer.fill(0, 0, count * 2);
  for (let i = 0; i < song.voices; i++) {
    if (song.voice[i].status !== VOICE_FREE) {
      mix_voice(song, song.common_buffer, i, count);
    }
  }
  song.current_sample += count;
}

export function mid_song_read_wave(song, outBuffer, offset, countSamples, callback) {
  if (!song.playing) return 0;

  const start_sample = song.current_sample;
  const end_sample = song.current_sample + countSamples;

  let writeOffset = offset;
  
  while (song.current_sample < end_sample) {
    while (song.current_event && song.current_event.time <= song.current_sample) {
      const ev = song.current_event;
      if(callback) {
        callback(ev);
      }
      switch (ev.type) {
        case ME_NOTEON:
          if (!ev.b) note_off(song, ev);
          else note_on(song, ev);
          break;
        case ME_NOTEOFF:
          note_off(song, ev);
          break;
        case ME_PITCHWHEEL:
          song.channel[ev.channel].pitchbend = ev.a + ev.b * 128;
          // Apply the new pitch bend to all active voices on this channel
          for(let i=0; i<song.voices; i++) {
            if(song.voice[i].status !== VOICE_FREE && song.voice[i].channel === ev.channel) {
              recompute_freq(song, i);
            }
          }
          break;
        case ME_MAINVOLUME:
          song.channel[ev.channel].volume = ev.a;
          break;
        case ME_PAN:
          song.channel[ev.channel].panning = ev.a;
          // Apply the new pan to all active voices on this channel
          for(let i=0; i<song.voices; i++) {
            if(song.voice[i].status !== VOICE_FREE && song.voice[i].channel === ev.channel) {
              vp_update_pan(song, i);
            }
          }
          break;
        case ME_EXPRESSION:
          if (song.channel[ev.channel].expression !== ev.a) {
            song.channel[ev.channel].expression = ev.a;
            // Apply the new expression to all active voices on this channel
            for(let i=0; i<song.voices; i++) {
              if(song.voice[i].status !== VOICE_FREE && song.voice[i].channel === ev.channel) {
                recompute_amp(song, i);
                apply_envelope_to_amp(song, i);
              }
            }
          }
          break;
        case ME_MODULATION:
          // Apply modulation as vibrato depth to active voices
          for(let i=0; i<song.voices; i++) {
            if(song.voice[i].status !== VOICE_FREE && song.voice[i].channel === ev.channel) {
              // This is a simplified mapping. A full implementation would be more complex.
              song.voice[i].vibrato_depth = ev.a;
            }
          }
          break;
        case ME_SUSTAIN:
          const sustain_on = ev.a >= 64;
          song.channel[ev.channel].sustain = sustain_on ? 1 : 0;
          if (!sustain_on) {
            for(let i=0; i<song.voices; i++) {
              if (song.voice[i].status === VOICE_SUSTAINED && song.voice[i].channel === ev.channel) {
                finish_note(song, i);
              }
            }
          }
          break;
        case ME_PROGRAM:
          if (ISDRUMCHANNEL(song, ev.channel)) {
            song.channel[ev.channel].program = ev.a;
          } else {
            song.channel[ev.channel].program = ev.a;
          }
          break;
        case ME_REVERB:
          song.setReverb?.(ev.a);
          break;
        case ME_CHORUS:
          song.setChorus?.(ev.a);
          break;
        case ME_EOT:
          song.playing = 0;
          return song.current_sample - start_sample;
      }
      
      const nextEv = ev.next;
      song.current_event = nextEv;
      if (!nextEv) break;
    }

    let nextEventTime = song.current_event ? song.current_event.time : end_sample;
    let limit = Math.min(end_sample, nextEventTime);
    let chunk = limit - song.current_sample;
    
    if (chunk > 0) {
      let remaining = chunk;
      while (remaining > 0) {
        let block = Math.min(remaining, song.buffer_size);
        do_compute_data(song, block);
        
        // Convert to Float32 [-1, 1] output
        for(let i=0; i<block*2; i++) {
           // The common_buffer contains 16-bit PCM data summed up.
           // We need to normalize it to the float range [-1.0, 1.0].
           // The original C code's output functions handle this scaling.
           outBuffer[writeOffset++] = song.common_buffer[i] / 32768.0;
        }
        remaining -= block;
      }
    }
  }

  return countSamples;
}

function vp_update_pan(song, v) {
  const vp = song.voice[v];
  vp.panning = song.channel[vp.channel].panning;
  recompute_amp(song, v);
  apply_envelope_to_amp(song, v);
}
