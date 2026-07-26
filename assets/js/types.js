export const ME_NONE = 0;
export const ME_NOTEON = 1;
export const ME_NOTEOFF = 2;
export const ME_KEYPRESSURE = 3;
export const ME_MAINVOLUME = 4;
export const ME_PAN = 5;
export const ME_SUSTAIN = 6;
export const ME_EXPRESSION = 7;
export const ME_PITCHWHEEL = 8;
export const ME_MODULATION = 17;
export const ME_PROGRAM = 9;
export const ME_TEMPO = 10;
export const ME_PITCH_SENS = 11;
export const ME_ALL_SOUNDS_OFF = 12;
export const ME_RESET_CONTROLLERS = 13;
export const ME_ALL_NOTES_OFF = 14;
export const ME_TONE_BANK = 15;
export const ME_LYRIC = 16;
export const ME_REVERB = 18;
export const ME_CHORUS = 19;
export const ME_EOT = 99;

export const MODES_16BIT = 1;
export const MODES_UNSIGNED = 2;
export const MODES_LOOPING = 4;
export const MODES_PINGPONG = 8;
export const MODES_REVERSE = 16;
export const MODES_SUSTAIN = 32;
export const MODES_ENVELOPE = 64;

export const SPECIAL_PROGRAM = -1;
export const MAGIC_LOAD_INSTRUMENT = -1;

export const VOICE_FREE = 0;
export const VOICE_ON = 1;
export const VOICE_SUSTAINED = 2;
export const VOICE_OFF = 3;
export const VOICE_DIE = 4;

export class MidSample {
  constructor() {
    this.data = null; // Float32Array
    this.data_length = 0;
    this.loop_start = 0;
    this.loop_end = 0;
    this.sample_rate = 0;
    this.low_freq = 0;
    this.high_freq = 0;
    this.root_freq = 0;
    this.panning = 0;
    this.modes = 0;
    this.volume = 1.0;
    
    // Envelope and LFO parameters
    this.envelope_rate = new Int32Array(6);
    this.envelope_offset = new Int32Array(6);
    this.tremolo_sweep_increment = 0;
    this.tremolo_phase_increment = 0;
    this.tremolo_depth = 0;
    this.vibrato_sweep_increment = 0;
    this.vibrato_control_ratio = 0;
    this.vibrato_depth = 0;
    this.note_to_use = 0;
  }
}

export class MidInstrument {
  constructor() {
    this.samples = 0;
    this.sample = []; // array of MidSample
  }
}

export class MidEvent {
  constructor() {
    this.time = 0; // sint32
    this.channel = 0; // uint8
    this.type = 0; // uint8
    this.a = 0; // uint8
    this.b = 0; // uint8
    this.track = 0; // uint8
  }
}

export class MidEventList {
  constructor() {
    this.event = new MidEvent();
    this.next = null;
  }
}

export class MidChannel {
  constructor() {
    this.bank = 0;
    this.program = 0;
    this.volume = 127;
    this.sustain = 0;
    this.panning = -1; // NO_PANNING
    this.pitchbend = 0;
    this.expression = 127;
    this.mono = 0;
    this.pitchsens = 2;
    this.pitchfactor = 0.0;
  }
}

export class MidVoice {
  // We'll populate this fully when porting playmidi.c
  constructor() {
    this.status = 0;
    this.channel = 0;
    this.note = 0;
    this.velocity = 0;
    this.sample = null;
    
    this.orig_frequency = 0;
    this.frequency = 0;
    this.sample_offset = 0;
    this.sample_increment = 0;
    this.envelope_volume = 0;
    this.envelope_target = 0;
    this.envelope_increment = 0;
    this.envelope_stage = 0;
    this.control_counter = 0;
    this.panned = 0;
    this.panning = 64;
    this.vibrato_control_counter = 0;
    this.vibrato_phase = 0;
    this.vibrato_sample_increment = new Int32Array(32);
    
    this.left_mix = 0;
    this.right_mix = 0;
    this.left_amp = 0.0;
    this.right_amp = 0.0;
  }
}

export class MidToneBankElement {
  constructor() {
    this.name = "";
    this.note = 0;
    this.amp = 0;
    this.pan = 0;
    this.strip_loop = 0;
    this.strip_envelope = 0;
    this.strip_tail = 0;
  }
}

export class MidToneBank {
  constructor() {
    this.tone = null;
    this.instrument = new Array(128).fill(null);
  }
}

export class MidSong {
  constructor() {
    this.oom = 0;
    this.playing = 0;
    this.rate = 0;
    this.encoding = 0;
    this.bytes_per_sample = 0;
    this.master_volume = 1.0;
    this.amplification = 100;
    
    this.tonebank = new Array(128).fill(null);
    this.drumset = new Array(128).fill(null);
    this.default_instrument = null;
    this.default_program = 0;
    
    this.buffer_size = 0;
    this.resample_buffer = null;
    this.common_buffer = null;
    
    this.sample_increment = 0;
    this.sample_correction = 0;
    
    this.channel = Array.from({ length: 16 }, () => new MidChannel());
    this.voice = Array.from({ length: 48 }, () => new MidVoice());
    this.voices = 32;
    this.drumchannels = 512;
    this.control_ratio = 0;
    this.lost_notes = 0;
    this.cut_notes = 0;
    this.samples = 0;
    
    this.events = null;
    this.current_event = null;
    this.evlist = null;
    this.current_sample = 0;
    this.event_count = 0;
    this.at = 0;
    this.groomed_event_count = 0;
    
    this.track_names = {};
    this.meta_data = new Array(10).fill(null);
  }
}

export function ISDRUMCHANNEL(song, c) {
  return (song.drumchannels & (1 << c)) !== 0;
}

export class MidIStream {
  constructor(buffer) {
    this.buffer = new Uint8Array(buffer); // ArrayBuffer or Uint8Array
    this.pos = 0;
  }

  read(length) {
    if (this.pos + length > this.buffer.length) {
      return null;
    }
    const res = this.buffer.subarray(this.pos, this.pos + length);
    this.pos += length;
    return res;
  }

  readUint8() {
    if (this.pos >= this.buffer.length) return null;
    return this.buffer[this.pos++];
  }

  readUint16BE() {
    if (this.pos + 2 > this.buffer.length) return null;
    const res = (this.buffer[this.pos] << 8) | this.buffer[this.pos + 1];
    this.pos += 2;
    return res;
  }

  readUint32BE() {
    if (this.pos + 4 > this.buffer.length) return null;
    const res = (this.buffer[this.pos] << 24) |
                (this.buffer[this.pos + 1] << 16) |
                (this.buffer[this.pos + 2] << 8) |
                this.buffer[this.pos + 3];
    this.pos += 4;
    return res >>> 0;
  }
  
  readInt32BE() {
    if (this.pos + 4 > this.buffer.length) return null;
    const res = (this.buffer[this.pos] << 24) |
                (this.buffer[this.pos + 1] << 16) |
                (this.buffer[this.pos + 2] << 8) |
                this.buffer[this.pos + 3];
    this.pos += 4;
    return res | 0;
  }
  
  readInt16BE() {
    if (this.pos + 2 > this.buffer.length) return null;
    const res = (this.buffer[this.pos] << 8) | this.buffer[this.pos + 1];
    this.pos += 2;
    return (res << 16) >> 16;
  }

  skip(length) {
    this.pos += length;
  }
  
  tell() {
    return this.pos;
  }
  
  seek(offset, whence) {
    if (whence === 0) { // SEEK_SET
      this.pos = offset;
    } else if (whence === 1) { // SEEK_CUR
      this.pos += offset;
    } else if (whence === 2) { // SEEK_END
      this.pos = this.buffer.length + offset;
    }
  }
}
