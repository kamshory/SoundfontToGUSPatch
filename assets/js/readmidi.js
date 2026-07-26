import {
  ME_NONE, ME_NOTEON, ME_NOTEOFF, ME_KEYPRESSURE, ME_MAINVOLUME, ME_PAN,
  ME_SUSTAIN, ME_EXPRESSION, ME_PITCHWHEEL, ME_MODULATION, ME_REVERB, ME_CHORUS,
  ME_PROGRAM, ME_TEMPO, ME_PITCH_SENS,
  ME_ALL_SOUNDS_OFF, ME_RESET_CONTROLLERS, ME_ALL_NOTES_OFF, ME_TONE_BANK, ME_LYRIC, ME_EOT,
  SPECIAL_PROGRAM, MAGIC_LOAD_INSTRUMENT, MidEvent, MidEventList, ISDRUMCHANNEL
} from './types.js';

// Computes how many (fractional) samples one MIDI delta-time unit contains
function compute_sample_increment(song, tempo, divisions) {
  const a = (tempo * song.rate * (65536.0 / 1000000.0)) / divisions;
  song.sample_correction = Math.floor(a) & 0xFFFF;
  song.sample_increment = Math.floor(a) >> 16;
}

// Read variable-length number
function getvl(stream) {
  let l = 0;
  while (true) {
    const c = stream.readUint8();
    if (c === null) return l;
    l += (c & 0x7f);
    if (!(c & 0x80)) return l;
    l <<= 7;
  }
}

const MID_SONG_TEXT = 1;
const MID_SONG_COPYRIGHT = 2;

function read_meta_data(stream, song, len, type, track) {
  const buf = stream.read(len);
  if (!buf) return -1;
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = buf[i];
    // Allow more characters for track names
    s += (c < 32 && c !== 9 && c !== 10 && c !== 13) ? '.' : String.fromCharCode(c);
  }
  
  if (type === 1) {
    song.meta_data[MID_SONG_TEXT] = s;
  } else if (type === 2) {
    song.meta_data[MID_SONG_COPYRIGHT] = s;
  } else if (type === 3) {
    song.track_names[track] = s;
  }
  return 0;
}
function read_track_name(stream, len) {
  const buf = stream.read(len);
  if (!buf) return "";
  return new TextDecoder().decode(buf);
}

const MAGIC_EOT = "MAGIC_EOT";

function createMidEvent(at, t, ch, pa, pb, track) {
  const newlist = new MidEventList();
  newlist.event.time = at;
  newlist.event.type = t;
  newlist.event.channel = ch;
  newlist.event.a = pa;
  newlist.event.b = pb;
  newlist.event.track = track;
  return newlist;
}

// We need an object for state that persists across read_midi_event calls
const readMidiState = {
  laststatus: 0,
  lastchan: 0,
  nrpn: 0,
  rpn_msb: new Uint8Array(16),
  rpn_lsb: new Uint8Array(16)
};

function read_midi_event(stream, song, track) {
  while (true) {
    song.at += getvl(stream);
    const me = stream.readUint8();
    if (me === null) return null;

    if (me === 0xF0 || me === 0xF7) {
      // SysEx event
      const len = getvl(stream);
      stream.skip(len);
    } else if (me === 0xFF) {
      // Meta event
      const type = stream.readUint8();
      const len = getvl(stream);
      if (type > 0 && type < 16) {
        read_meta_data(stream, song, len, type, track);
      } else {
        switch (type) {
          case 0x2F: // End of Track
            return MAGIC_EOT;
          case 0x51: // Tempo
            const a = stream.readUint8();
            const b = stream.readUint8();
            const c = stream.readUint8();
            return createMidEvent(song.at, ME_TEMPO, c, a, b, track);
          default:
            stream.skip(len);
            break;
        }
      }
    } else {
      let a = me;
      if (a & 0x80) { // status byte
        readMidiState.lastchan = a & 0x0F;
        readMidiState.laststatus = (a >> 4) & 0x07;
        a = stream.readUint8();
        a &= 0x7F;
      }
      
      let b;
      switch (readMidiState.laststatus) {
        case 0: // Note off
          b = stream.readUint8() & 0x7F;
          return createMidEvent(song.at, ME_NOTEOFF, readMidiState.lastchan, a, b, track);
          
        case 1: // Note on
          b = stream.readUint8() & 0x7F;
          return createMidEvent(song.at, ME_NOTEON, readMidiState.lastchan, a, b, track);
          
        case 2: // Key Pressure
          b = stream.readUint8() & 0x7F;
          return createMidEvent(song.at, ME_KEYPRESSURE, readMidiState.lastchan, a, b, track);
          
        case 3: // Control change
          b = stream.readUint8() & 0x7F;
          let control = 255;
          switch (a) {
            case 1: control = ME_MODULATION; break;
            case 7: control = ME_MAINVOLUME; break;
            case 10: control = ME_PAN; break;
            case 11: control = ME_EXPRESSION; break;
            case 64: control = ME_SUSTAIN; b = (b >= 64) ? 1 : 0; break;
            case 91: control = ME_REVERB; break;
            case 93: control = ME_CHORUS; break;
            case 120: control = ME_ALL_SOUNDS_OFF; break;
            case 121: control = ME_RESET_CONTROLLERS; break;
            case 123: control = ME_ALL_NOTES_OFF; break;
            case 0: control = ME_TONE_BANK; break;
            case 32:
              if (b !== 0) {
                // Ignore Bank Select LSB
              }
              break;
            case 100: readMidiState.nrpn = 0; readMidiState.rpn_msb[readMidiState.lastchan] = b; break;
            case 101: readMidiState.nrpn = 0; readMidiState.rpn_lsb[readMidiState.lastchan] = b; break;
            case 99: readMidiState.nrpn = 1; readMidiState.rpn_msb[readMidiState.lastchan] = b; break;
            case 98: readMidiState.nrpn = 1; readMidiState.rpn_lsb[readMidiState.lastchan] = b; break;
            case 6:
              if (readMidiState.nrpn) break;
              const rpn = (readMidiState.rpn_msb[readMidiState.lastchan] << 8) | readMidiState.rpn_lsb[readMidiState.lastchan];
              switch (rpn) {
                case 0x0000: // Pitch bend sensitivity
                  control = ME_PITCH_SENS;
                  return createMidEvent(song.at, control, readMidiState.lastchan, b, 0, track);
                case 0x7F7F: // RPN reset
                  return createMidEvent(song.at, ME_PITCH_SENS, readMidiState.lastchan, 2, 0, track);
              }
              break;
          }
          if (control !== 255) {
            return createMidEvent(song.at, control, readMidiState.lastchan, b, 0, track);
          }
          break;
          
        case 4: // Program change
          a &= 0x7f;
          return createMidEvent(song.at, ME_PROGRAM, readMidiState.lastchan, a, 0, track);
          
        case 5: // Channel pressure
          break;
          
        case 6: // Pitch wheel
          b = stream.readUint8() & 0x7F;
          return createMidEvent(song.at, ME_PITCHWHEEL, readMidiState.lastchan, a, b, track);
      }
    }
  }
}

function read_track(stream, song, append, track) {
  let meep = song.evlist;
  if (append && meep) {
    while (meep.next) {
      meep = meep.next;
    }
    song.at = meep.event.time;
  } else {
    song.at = 0;
  }

  const tmp = stream.read(4);
  if (!tmp || tmp.length !== 4) return -1;
  let len = stream.readUint32BE();
  if (len === null) return -1;
  
  const next_pos = stream.tell() + len;
  
  const mtrkStr = String.fromCharCode(tmp[0], tmp[1], tmp[2], tmp[3]);
  if (mtrkStr !== "MTrk") return -2;

  while (true) {
    const newlist = read_midi_event(stream, song, track);
    if (!newlist) return -2; // Error

    if (newlist === MAGIC_EOT) {
      const pos = stream.tell();
      if (pos < next_pos) {
        stream.seek(next_pos - pos, 1); // SEEK_CUR
      }
      return 0;
    }

    let next = meep.next;
    while (next && (next.event.time < newlist.event.time)) {
      meep = next;
      next = meep.next;
    }

    newlist.next = next;
    meep.next = newlist;
    song.event_count++;
    meep = newlist;
  }
}

function free_midi_list(song) {
  song.evlist = null; // GC will handle it
}

function groom_list(song, divisions) {
  let tempo = 500000;
  
  const current_bank = new Array(16).fill(0);
  const current_set = new Array(16).fill(0);
  const current_program = new Array(16).fill(song.default_program);
  
  compute_sample_increment(song, tempo, divisions);
  
  const groomed_list = [];
  let meep = song.evlist;
  
  // Store a copy of the raw, sorted event list for tick-to-sample conversion
  const raw_events = [];
  for(let p = meep; p; p = p.next) {
    raw_events.push(p.event);
  }
  let st = 0, at = 0, sample_cum = 0, counting_time = 0;
  
  while (meep) {
    let skip_this_event = false;
    
    if (meep.event.type === ME_TEMPO) {
      skip_this_event = true;
    } else {
      switch (meep.event.type) {
        case ME_PROGRAM:
          if (ISDRUMCHANNEL(song, meep.event.channel)) {
            let new_value = meep.event.a;
            if (current_set[meep.event.channel] !== new_value) {
              current_set[meep.event.channel] = new_value;
            } else {
              skip_this_event = true;
            }
          } else {
            let new_value = meep.event.a;
            if (current_program[meep.event.channel] !== SPECIAL_PROGRAM &&
                current_program[meep.event.channel] !== new_value) {
              current_program[meep.event.channel] = new_value;
            } else {
              skip_this_event = true;
            }
          }
          break;
          
        case ME_NOTEON:
          if (counting_time) counting_time = 1;
          if (ISDRUMCHANNEL(song, meep.event.channel)) {
            const drum_set_num = current_set[meep.event.channel];
            const note = meep.event.a;
            if (!song.drumset[drum_set_num]) {
              song.drumset[drum_set_num] = { instrument: new Array(128).fill(null) };
            }
            song.drumset[drum_set_num].instrument[note] = MAGIC_LOAD_INSTRUMENT;
          } else {
            if (current_program[meep.event.channel] === SPECIAL_PROGRAM) break;
            let prog = current_program[meep.event.channel];
            if (!song.tonebank[0]) song.tonebank[0] = { instrument: new Array(128).fill(null) };
            song.tonebank[0].instrument[prog] = MAGIC_LOAD_INSTRUMENT;
          }
          break;
          
        case ME_TONE_BANK:
          if (ISDRUMCHANNEL(song, meep.event.channel)) {
            skip_this_event = true;
            break;
          }
          let new_value = meep.event.a;
          if (current_bank[meep.event.channel] !== new_value) {
            current_bank[meep.event.channel] = new_value;
          } else {
            skip_this_event = true;
          }
          break;
      }
    }

    const dt = meep.event.time - at;
    if (dt && !counting_time) {
      const samples_to_do = song.sample_increment * dt;
      sample_cum += song.sample_correction * dt;
      let extra = (sample_cum >> 16) & 0xFFFF;
      st += samples_to_do + extra;
      sample_cum &= 0x0000FFFF;
    } else if (counting_time === 1) {
      counting_time = 0;
    }
    
    if (meep.event.type === ME_TEMPO) {
      tempo = meep.event.channel + meep.event.b * 256 + meep.event.a * 65536;
      compute_sample_increment(song, tempo, divisions);
    }
    
    if (!skip_this_event) {
      const ev = new MidEvent();
      ev.time = st;
      ev.type = meep.event.type;
      ev.channel = meep.event.channel;
      ev.a = meep.event.a;
      ev.b = meep.event.b;
      ev.track = meep.event.track; // CRITICAL FIX: Copy the track number
      if (groomed_list.length > 0) {
        groomed_list[groomed_list.length - 1].next = ev;
      }
      groomed_list.push(ev);
    }
    
    at = meep.event.time;
    meep = meep.next;
  }
  
  const eot = new MidEvent();
  eot.time = st;
  eot.type = ME_EOT;
  if (groomed_list.length > 0) {
    groomed_list[groomed_list.length - 1].next = eot;
  }
  groomed_list.push(eot);
  
  free_midi_list(song);
  
  return {
    song: song,
    events: groomed_list,
    count: groomed_list.length,
    samples: st,
    rawEvents: raw_events,
    divisions: divisions,
  };
}

export function read_midi_file(stream, song) {
  song.event_count = 0;
  song.at = 0;
  song.evlist = null;
  song.track_names = {};
  
  let tmp = stream.read(4);
  if (!tmp) return null;
  let len = stream.readUint32BE();
  if (len === null) return null;
  
  let sig = String.fromCharCode(tmp[0], tmp[1], tmp[2], tmp[3]);
  if (sig === "RIFF") {
    // RMID handling - skip
    tmp = stream.read(4); sig = String.fromCharCode(...tmp);
    if (sig !== "RMID") return null;
    tmp = stream.read(4); sig = String.fromCharCode(...tmp);
    if (sig !== "data") return null;
    tmp = stream.read(4); // should be MThd
    len = stream.readUint32BE();
    sig = String.fromCharCode(...tmp);
  }
  
  if (sig !== "MThd" || len < 6) {
    return null;
  }
  
  let format = stream.readUint16BE();
  let tracks = stream.readUint16BE();
  let divisions_tmp = stream.readInt16BE();
  
  let divisions;
  if (divisions_tmp < 0) {
    divisions = (-(divisions_tmp / 256)) * (divisions_tmp & 0xFF);
  } else {
    divisions = divisions_tmp;
  }
  
  if (len > 6) {
    stream.skip(len - 6);
  }
  
  if (format < 0 || format > 2 || tracks < 1) return null;
  if (format === 0 && tracks !== 1) return null;
  
  song.evlist = new MidEventList();
  song.evlist.event.type = ME_NONE;
  song.event_count++;
  
  if (format === 0) {
    if (read_track(stream, song, 0, 0)) return null;
  } else if (format === 1) {
    for (let i = 0; i < tracks; i++) {
      if (read_track(stream, song, 0, i)) return null;
    }
  } else if (format === 2) {
    for (let i = 0; i < tracks; i++) {
      if (read_track(stream, song, 1, i)) return null;
    }
  }
  
  return groom_list(song, divisions);
}
