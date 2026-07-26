import { VOICE_FREE, VOICE_ON, VOICE_SUSTAINED, MODES_ENVELOPE } from './types.js';
import { vol_table } from './tables.js';
import { resample_voice } from './resample.js';

const AMP_BITS = 15; // From timidity_internal.h
const MAX_AMP_VALUE = (1 << 31) - 1; // 32-bit max

function TIM_FSCALE(a, b) {
  return a * (1 << b);
}

export function recompute_envelope(song, v) {
  const vp = song.voice[v];
  const stage = vp.envelope_stage;

  if (stage > 5) {
    vp.status = VOICE_FREE;
    return 1;
  }

  if (vp.sample.modes & MODES_ENVELOPE) {
    if (vp.status === VOICE_ON || vp.status === VOICE_SUSTAINED) {
      if (stage > 2) {
        vp.envelope_increment = 0;
        return 0;
      }
    }
  }

  vp.envelope_stage = stage + 1;

  if (vp.envelope_volume === vp.sample.envelope_offset[stage] ||
      (stage > 2 && vp.envelope_volume < vp.sample.envelope_offset[stage])) {
    return recompute_envelope(song, v);
  }

  vp.envelope_target = vp.sample.envelope_offset[stage];
  vp.envelope_increment = vp.sample.envelope_rate[stage];
  if (vp.envelope_target < vp.envelope_volume) {
    vp.envelope_increment = -vp.envelope_increment;
  }
  return 0;
}

export function apply_envelope_to_amp(song, v) {
  const vp = song.voice[v];
  let lamp = vp.left_amp;
  let ramp;
  
  if (vp.panned === 3 /* PANNED_MYSTERY */) {
    ramp = vp.right_amp;
    if (vp.sample.modes & MODES_ENVELOPE) {
      const idx = vp.envelope_volume >> 23;
      const vol = (idx >= 0 && idx < vol_table.length) ? vol_table[idx] : 0;
      lamp *= vol;
      ramp *= vol;
    }
    
    let la = TIM_FSCALE(lamp, AMP_BITS) | 0;
    let ra = TIM_FSCALE(ramp, AMP_BITS) | 0;
    
    vp.left_mix = la;
    vp.right_mix = ra;
  } else {
    if (vp.sample.modes & MODES_ENVELOPE) {
      const idx = vp.envelope_volume >> 23;
      const vol = (idx >= 0 && idx < vol_table.length) ? vol_table[idx] : 0;
      lamp *= vol;
    }
    
    let la = TIM_FSCALE(lamp, AMP_BITS) | 0;
    vp.left_mix = la;
    
    // CRITICAL FIX: Also process the right channel for centered and stereo audio
    if (vp.panned === 1 /* PANNED_CENTER */ || vp.panned === 3 /* PANNED_MYSTERY */) {
      let ra = TIM_FSCALE(ramp, AMP_BITS) | 0;
      vp.right_mix = ra;
    }
  }

  vp.left_mix = TIM_FSCALE(lamp, AMP_BITS) | 0;

  // For stereo or centered sound, calculate the right mix.
  // For left/right-panned sounds, right_amp is 0, so right_mix will be 0.
  vp.right_mix = TIM_FSCALE(ramp, AMP_BITS) | 0;
}

function update_envelope(song, v) {
  const vp = song.voice[v];
  vp.envelope_volume += vp.envelope_increment;
  
  if (((vp.envelope_increment < 0) && (vp.envelope_volume <= vp.envelope_target)) ||
      ((vp.envelope_increment > 0) && (vp.envelope_volume >= vp.envelope_target))) {
    vp.envelope_volume = vp.envelope_target;
    if (recompute_envelope(song, v)) {
      return 1;
    }
  }
  return 0;
}

function update_signal(song, v) {
  const vp = song.voice[v];
  if (vp.envelope_increment && update_envelope(song, v)) {
    return 1;
  }
  apply_envelope_to_amp(song, v);
  return 0;
}

export function mix_voice(song, buf, v, c) {
  const vp = song.voice[v];
  let countptr = [c];
  const sp = resample_voice(song, v, countptr);
  let count = countptr[0];
  
  if (count <= 0) return;
  
  // mix into common buffer
  let spIdx = 0;
  let lp = 0;
  
  let left = vp.left_mix;
  let right = vp.right_mix;
  
  let cc = vp.control_counter;
  if (!cc) {
    cc = song.control_ratio;
    if (update_signal(song, v)) return;
    // After update_signal, increments are set. left/right are the starting points.
  }
  
  const isMystery = vp.panned === 3; // Stereo
  const isCenter = vp.panned === 1;  // Center
  const isLeft = vp.panned === 0;   // Left
  const isRight = vp.panned === 2;  // Right
  
  while (count > 0) {
    if (cc < count) {
      count -= cc;
      while (cc--) {
        const s = sp[spIdx++];
        if (isMystery) {
          buf[lp++] += (left * s) | 0;
          buf[lp++] += (right * s) | 0;
        } else if (isCenter) {
          // For CENTER, both channels use left_mix as the source
          const val = (left * s) | 0; 
          buf[lp++] += val;
          buf[lp++] += val;
        } else if (isLeft) {
          buf[lp++] += (left * s) | 0;
          lp++;
        } else if (isRight) {
          lp++;
          // CRITICAL FIX: PANNED_RIGHT uses left_mix as its source, just like the C version.
          buf[lp++] += (left * s) | 0;
        }
      }
      cc = song.control_ratio;
      if (update_signal(song, v)) return;
      left = vp.left_mix;
      right = vp.right_mix;
    } else {
      vp.control_counter = cc - count;
      while (count--) {
        const s = sp[spIdx++];
        if (isMystery) {
          buf[lp++] += (left * s) | 0;
          buf[lp++] += (right * s) | 0;
        } else if (isCenter) {
          // For CENTER, both channels use left_mix as the source
          const val = (left * s) | 0;
          buf[lp++] += val;
          buf[lp++] += val;
        } else if (isLeft) {
          buf[lp++] += (left * s) | 0;
          lp++;
        } else if (isRight) {
          lp++;
          // CRITICAL FIX: PANNED_RIGHT uses left_mix as its source, just like the C version.
          buf[lp++] += (left * s) | 0;
        }
      }
      return;
    }
  }
}
