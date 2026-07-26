import { MidInstrument, MidSample, MAGIC_LOAD_INSTRUMENT, SPECIAL_PROGRAM, MODES_16BIT, MODES_UNSIGNED, MODES_LOOPING, MODES_PINGPONG, MODES_REVERSE, MODES_SUSTAIN, MODES_ENVELOPE } from './types.js';

function convert_envelope_rate(rate, song_rate, control_ratio) {
  let r = 3 - ((rate >> 6) & 3);
  r *= 3;
  r = (rate & 0x3f) << r;
  r = Math.floor((r * 44100) / song_rate) * control_ratio;
  return r << 9; // 15.15 fixed point
}

function convert_envelope_offset(offset) {
  return offset << (7 + 15);
}

function convert_tremolo_sweep(sweep, song_rate, control_ratio) {
  if (!sweep) return 0;
  return Math.floor(((control_ratio * 40) << 16) / (song_rate * sweep)); // SWEEP_TUNING = 40, SWEEP_SHIFT = 16
}

function convert_vibrato_sweep(sweep, vib_control_ratio, song_rate) {
  if (!sweep) return 0;
  return Math.floor(((vib_control_ratio * 40) * (1 << 16)) / (song_rate * sweep));
}

function convert_tremolo_rate(rate, song_rate, control_ratio) {
  return Math.floor(((1024 * control_ratio * rate) << 10) / (38 * song_rate)); // SINE_CYCLE_LENGTH=1024, RATE_SHIFT=10
}

function convert_vibrato_rate(rate, song_rate) {
  return Math.floor((32 * song_rate) / (rate * 2 * 32)); // VIBRATO_RATE_TUNING=32, MID_VIBRATO_SAMPLE_INCREMENTS=32
}

export class InstrumentLoader {
  constructor(song, baseUrl) {
    this.song = song;
    this.baseUrl = baseUrl;
    this.cfgMap = new Map(); // program -> { file, options }
    this.drumMap = new Map(); // program -> { file, options }
    this.soundfontFiles = new Set();
    this.instrumentCache = new Map(); // Cache untuk instrumen yang sudah dimuat
  }

  async loadConfig(cfgUrl) {
    if(this.baseUrl && cfgUrl) {
      try {
        const response = await fetch(this.baseUrl + cfgUrl);
        if (!response.ok) throw new Error(`Could not load ${this.baseUrl + cfgUrl}`);
        const text = await response.text();
        this.parseConfig(text);
      } catch (e) {
        console.error("Error loading config:", e);
      }
    }
  }

  parseConfig(text) {
    const lines = text.split('\n');
    let isDrum = false;
    let bank = 0;

    for (let line of lines) {
      line = line.split('#')[0].trim();
      if (!line) continue;

      const parts = line.split(/\s+/);
      if (parts[0] === 'bank') {
        bank = parseInt(parts[1], 10);
        isDrum = false;
      } else if (parts[0] === 'drumset') {
        bank = parseInt(parts[1], 10);
        isDrum = true;
      } else if (parts[0] === 'source') {
        // handle nested cfg includes if necessary
      } else if (parts.length >= 2) {
        const prog = parseInt(parts[0], 10);
        const file = parts[1];

        if (file.toLowerCase().endsWith('.sf2')) {
          this.soundfontFiles.add(file);
          continue; // Skip the rest of the logic for SF2 files
        }

        const options = { file: parts[1], pan: -1, amp: -1 }; // -1 means not set
        if (!options.file.toLowerCase().endsWith('.pat')) options.file += '.pat';

        // Parse extra options like pan=center or amp=100
        for (let i = 2; i < parts.length; i++) {
          const [key, value] = parts[i].split('=');
          if (key === 'pan') {
            if (value === 'center') options.pan = 64;
            else if (value === 'left') options.pan = 0;
            else if (value === 'right') options.pan = 127;
            else options.pan = parseInt(value, 10);
          } else if (key === 'amp') {
            options.amp = parseInt(value, 10);
          }
        }

        if (isDrum) {
          this.drumMap.set(prog, options);
        } else {
          this.cfgMap.set(prog, options);
        }
      }
    }
  }

  async _loadSoundfonts() {
    if (this.soundfontFiles.size === 0) return;
    const promises = [];
    for (const sf2file of this.soundfontFiles) {
      promises.push(
        fetch(this.baseUrl + sf2file)
          .then(res => res.arrayBuffer())
          .then(buffer => this._parseSf2(buffer))
          .catch(err => console.error(`Failed to load SoundFont ${sf2file}:`, err))
      );
    }
    await Promise.allSettled(promises);
  }

  _parseSf2(buffer, fileName) {
    console.log(`Parsing SoundFont: ${fileName}`);
    const dv = new DataView(buffer);
    let p = 0;

    // Helper to read FourCC codes
    const readFourCC = () => {
      const str = String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
      p += 4;
      return str;
    };

    if (readFourCC() !== 'RIFF') return;
    p += 4; // Skip chunk size
    if (readFourCC() !== 'sfbk') return;

    let pdta = null, smpl = null;

    // Find pdta and sdta chunks
    while (p < dv.byteLength) {
      const id = readFourCC();
      const size = dv.getUint32(p, true);
      p += 4;
      if (id === 'LIST') {
        const listType = readFourCC();
        if (listType === 'pdta') {
          pdta = new DataView(buffer, p, size - 4);
        } else if (listType === 'sdta') {
          // Find the 'smpl' sub-chunk
          let subp = p;
          while(subp < p + size - 4) {
            const subId = String.fromCharCode(dv.getUint8(subp), dv.getUint8(subp + 1), dv.getUint8(subp + 2), dv.getUint8(subp + 3));
            subp += 4;
            const subSize = dv.getUint32(subp, true);
            subp += 4;
            if (subId === 'smpl') {
              smpl = new DataView(buffer, subp, subSize);
              break;
            }
            subp += subSize;
          }
        }
      }
      p += size;
      if (p % 2 !== 0) p++; // Word alignment
    }

    if (!pdta || !smpl) {
      console.error("SF2 file is missing pdta or sdta chunk.");
      return;
    }

    // Parse the 'pdta' hydra
    p = 0;
    const hydra = {};
    while (p < pdta.byteLength) {
      const id = String.fromCharCode(pdta.getUint8(p), pdta.getUint8(p + 1), pdta.getUint8(p + 2), pdta.getUint8(p + 3));
      p += 4;
      const size = pdta.getUint32(p, true);
      p += 4;
      hydra[id] = new DataView(pdta.buffer, pdta.byteOffset + p, size);
      p += size;
      if (p % 2 !== 0) p++;
    }

    // Extract sample headers
    const samples = [];
    for (let i = 0; i < hydra.shdr.byteLength - 46; i += 46) {
      samples.push({
        name: String.fromCharCode.apply(null, new Uint8Array(hydra.shdr.buffer, hydra.shdr.byteOffset + i, 20)).split('\0')[0],
        start: hydra.shdr.getUint32(i + 20, true),
        end: hydra.shdr.getUint32(i + 24, true),
        loopStart: hydra.shdr.getUint32(i + 28, true),
        loopEnd: hydra.shdr.getUint32(i + 32, true),
        sampleRate: hydra.shdr.getUint32(i + 36, true),
        originalPitch: hydra.shdr.getUint8(i + 40),
        pitchCorrection: hydra.shdr.getInt8(i + 41),
      });
    }

    // Extract instruments
    const instruments = [];
    for (let i = 0; i < hydra.inst.byteLength - 22; i += 22) {
      instruments.push({
        name: String.fromCharCode.apply(null, new Uint8Array(hydra.inst.buffer, hydra.inst.byteOffset + i, 20)).split('\0')[0],
        bagIndex: hydra.inst.getUint16(i + 20, true)
      });
    }

    // Extract presets
    for (let i = 0; i < hydra.phdr.byteLength - 38; i += 38) {
      const presetName = String.fromCharCode.apply(null, new Uint8Array(hydra.phdr.buffer, hydra.phdr.byteOffset + i, 20)).split('\0')[0];
      const program = hydra.phdr.getUint16(i + 20, true);
      const bank = hydra.phdr.getUint16(i + 22, true);
      const bagIndex = hydra.phdr.getUint16(i + 24, true);

      const isDrum = (bank === 128);
      if (bank !== 0 && !isDrum) continue; // Only load bank 0 for melodic

      const midInst = new MidInstrument();
      midInst.name = presetName;

      // Iterate through preset zones
      for (let j = bagIndex; j < hydra.phdr.getUint16(i + 28, true); j++) {
        const pgenIndex = hydra.pbag.getUint16(j * 4, true);
        // Find the instrument generator for this preset zone
        for (let k = pgenIndex; k < hydra.pbag.getUint16((j + 1) * 4, true); k++) {
          const genId = hydra.pgen.getUint16(k * 4, true);
          if (genId === 41) { // Generator 41 is 'instrument'
            const instId = hydra.pgen.getUint16(k * 4 + 2, true);
            const instrument = instruments[instId];
            if (!instrument) continue;

            // Now iterate through the instrument's zones
            for (let m = instrument.bagIndex; m < instruments[instId + 1].bagIndex; m++) {
              const igenIndex = hydra.ibag.getUint16(m * 4, true);
              let sampleId = -1;
              for (let n = igenIndex; n < hydra.ibag.getUint16((m + 1) * 4, true); n++) {
                if (hydra.igen.getUint16(n * 4, true) === 53) { // Generator 53 is 'sampleID'
                  sampleId = hydra.igen.getUint16(n * 4 + 2, true);
                  break;
                }
              }

              if (sampleId !== -1) {
                const sampleHeader = samples[sampleId];
                const midSample = new MidSample();
                midSample.sample_rate = sampleHeader.sampleRate;
                midSample.modes = MODES_16BIT; // SF2 is always 16-bit signed
                midSample.modes |= MODES_LOOPING | MODES_SUSTAIN;

                const sampleLen = sampleHeader.end - sampleHeader.start;
                midSample.data_length = sampleLen << 12;
                midSample.loop_start = (sampleHeader.loopStart - sampleHeader.start) << 12;
                midSample.loop_end = (sampleHeader.loopEnd - sampleHeader.start) << 12;
                midSample.root_freq = freq_table[sampleHeader.originalPitch] * Math.pow(2, sampleHeader.pitchCorrection / 1200);

                // Extract and convert sample data
                midSample.data = new Float32Array(sampleLen);
                for (let s = 0; s < sampleLen; s++) {
                  midSample.data[s] = smpl.getInt16((sampleHeader.start + s) * 2, true) / 32768.0;
                }
                midInst.sample.push(midSample);
              }
            }
          }
        }
      }

      if (midInst.sample.length > 0) {
        if (isDrum) {
          if (!this.song.drumset[0]) this.song.drumset[0] = { instrument: new Array(128).fill(null) };
          this.song.drumset[0].instrument[program] = midInst;
        } else {
          if (!this.song.tonebank[0]) this.song.tonebank[0] = { instrument: new Array(128).fill(null) };
          this.song.tonebank[0].instrument[program] = midInst;
        }
      }
    }
  }

  async loadMissingInstruments() {
    await this._loadSoundfonts();

    const instrumentsToLoad = [];

    // First, collect all instruments that need to be loaded
    for (let i = 0; i < 128; i++) {
      // Check Melodic bank 0
      if (this.song.tonebank[0] && this.song.tonebank[0].instrument[i] === MAGIC_LOAD_INSTRUMENT) {
        const patchInfo = this.cfgMap.get(i);
        if (patchInfo) {
          instrumentsToLoad.push({ type: 'tone', program: i, patchInfo });
        } else {
          this.song.tonebank[0].instrument[i] = null;
          console.warn("No patch mapped for tone program", i);
        }
      }
      // Check Drumset 0
      if (this.song.drumset[0] && this.song.drumset[0].instrument[i] === MAGIC_LOAD_INSTRUMENT) {
        const patchInfo = this.drumMap.get(i);
        if (patchInfo) {
          instrumentsToLoad.push({ type: 'drum', program: i, patchInfo });
        } else {
          this.song.drumset[0].instrument[i] = null;
          console.warn("No patch mapped for drum program", i);
        }
      }
    }

    const totalToLoad = instrumentsToLoad.length;

    if (totalToLoad === 0) return 0;

    // Count missing instrument save it into a list
    let missingInstrument = [];
    let missingInstrumentCount = 0;
    let realLoadedInstrument = 0;

    for (const item of instrumentsToLoad) {
      if (!this.instrumentCache.has(item.patchInfo.file)) {
        missingInstrument.push(item);
        missingInstrumentCount++;
      }
    }

    // Now, load them one by one and report progress
    for (const item of instrumentsToLoad) {
      // Cek cache terlebih dahulu
      let inst = this.instrumentCache.get(item.patchInfo.file);
      if (!inst) {
        // Jika tidak ada di cache, baru load dari jaringan
        inst = await this.loadPatch(item.patchInfo.file, item.patchInfo.pan);
        if (inst) {
          this.instrumentCache.set(item.patchInfo.file, inst); // Simpan ke cache jika berhasil
          realLoadedInstrument++;
          this.onProgress?.(realLoadedInstrument, missingInstrumentCount, item.patchInfo.file);
        }
      }

      if (item.type === 'tone') this.song.tonebank[0].instrument[item.program] = inst;
      else this.song.drumset[0].instrument[item.program] = inst;      
    }

    return realLoadedInstrument;
  }

  async loadSingleInstrument(program) {
    // Ensure tonebank 0 exists
    if (!this.song.tonebank[0]) {
      this.song.tonebank[0] = { instrument: new Array(128).fill(null) };
    }
    // Check if the instrument is already loaded or being loaded
    if (this.song.tonebank[0].instrument[program]) return;

    const patchInfo = this.cfgMap.get(program);
    if (patchInfo) {
      let inst = this.instrumentCache.get(patchInfo.file);
      if (!inst) {
        inst = await this.loadPatch(patchInfo.file, patchInfo.pan);
        if (inst) {
          this.instrumentCache.set(patchInfo.file, inst);
        }
      }
      if (inst) this.song.tonebank[0].instrument[program] = inst;
    }
  }

  async loadPatch(filename, panOverride) {
    try {
      const path = filename;
      const res = await fetch(this.baseUrl + path);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const buffer = await res.arrayBuffer();
      return this.parsePatBuffer(buffer, filename, panOverride);
    } catch (e) {
      console.warn("Failed to load patch:", filename, e);
      return null;
    }
  }

  parsePatBuffer(buffer, name, panOverride) {
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    
    // Check signature
    let sig = "";
    for(let i=0; i<11; i++) sig += String.fromCharCode(u8[i]);
    if (sig !== "GF1PATCH110" && sig !== "GF1PATCH100") {
      console.error("Invalid PAT signature for", name);
      return null;
    }

    const inst = new MidInstrument();
    inst.samples = u8[198];
    inst.sample = [];

    let offset = 239;
    for (let i = 0; i < inst.samples; i++) {
      if (offset >= buffer.byteLength) break;

      const sp = new MidSample();
      
      // Skip wave name
      offset += 7;
      const fractions = u8[offset++];
      
      sp.data_length = dv.getUint32(offset, true); offset += 4;
      sp.loop_start = dv.getUint32(offset, true); offset += 4;
      sp.loop_end = dv.getUint32(offset, true); offset += 4;
      sp.sample_rate = dv.getUint16(offset, true); offset += 2;
      sp.low_freq = dv.getUint32(offset, true); offset += 4;
      sp.high_freq = dv.getUint32(offset, true); offset += 4;
      sp.root_freq = dv.getUint32(offset, true); offset += 4;

      // CRITICAL FIX: Original C code does fseek(fp, 2, SEEK_CUR) here for 'tune'.
      offset += 2;
      
      if (panOverride !== -1) {
        sp.panning = (panOverride & 0x7F); // Config file panning is already mapped
        offset++; // Still need to advance past the panning byte in the file
      } else {
        sp.panning = (u8[offset] * 8 + 4) & 0x7F; // Use panning from patch file (0-15 mapped to 0-127)
        offset++;
      }
      
      // Envelopes & LFO (18 bytes)
      let tmp = new Uint8Array(buffer, offset, 18);
      offset += 18;
      
      if (!tmp[13] || !tmp[14]) {
        sp.tremolo_sweep_increment = sp.tremolo_phase_increment = sp.tremolo_depth = 0;
      } else {
        sp.tremolo_sweep_increment = convert_tremolo_sweep(tmp[12], this.song.rate, this.song.control_ratio);
        sp.tremolo_phase_increment = convert_tremolo_rate(tmp[13], this.song.rate, this.song.control_ratio);
        sp.tremolo_depth = tmp[14];
      }
      
      if (!tmp[16] || !tmp[17]) {
        sp.vibrato_sweep_increment = sp.vibrato_control_ratio = sp.vibrato_depth = 0;
      } else {
        sp.vibrato_control_ratio = convert_vibrato_rate(tmp[16], this.song.rate);
        sp.vibrato_sweep_increment = convert_vibrato_sweep(tmp[15], sp.vibrato_control_ratio, this.song.rate);
        sp.vibrato_depth = tmp[17];
      }
      
      sp.modes = u8[offset++];
      offset += 40; // Skip scale and reserved

      let modeStr = [];
      if (sp.modes & MODES_16BIT) modeStr.push("16-bit"); else modeStr.push("8-bit");
      if (sp.modes & MODES_UNSIGNED) modeStr.push("unsigned"); else modeStr.push("signed");
      if (sp.modes & MODES_LOOPING) modeStr.push("looping");
      if (sp.modes & MODES_PINGPONG) modeStr.push("ping-pong");
      if (sp.modes & MODES_REVERSE) modeStr.push("reverse");
      if (sp.modes & MODES_ENVELOPE) modeStr.push("envelope");
      
      if (sp.modes & MODES_LOOPING) sp.modes |= MODES_SUSTAIN; // MODES_LOOPING -> MODES_SUSTAIN

      for (let j = 0; j < 6; j++) {
        sp.envelope_rate[j] = convert_envelope_rate(tmp[j], this.song.rate, this.song.control_ratio);
        sp.envelope_offset[j] = convert_envelope_offset(tmp[6+j]);
      }
      
      sp.volume = 1.0;
      
      // Read PCM Data
      let bytesToRead = sp.data_length;
      // Boundary check to prevent RangeError
      if (offset + bytesToRead > buffer.byteLength) {
        console.error(`Patch ${name}: data_length (${bytesToRead}) at offset ${offset} exceeds buffer bounds (${buffer.byteLength}). Truncating.`);
        bytesToRead = buffer.byteLength - offset;
      }

      if (sp.modes & MODES_16BIT) { // 16-bit
        const numSamples = Math.floor(bytesToRead / 2);
        sp.data = new Float32Array(numSamples + 2); // +2 for guard samples
        let ptr = offset;
        for (let s = 0; s < numSamples; s++) {
          let val;
          if (sp.modes & MODES_UNSIGNED) { // unsigned
            val = dv.getUint16(ptr, true) - 32768;
          } else { // signed
            val = dv.getInt16(ptr, true);
          }
          sp.data[s] = val / 32768.0;
          ptr += 2;
        }
        sp.data_length = numSamples; // Store sample count, not bytes
        // For 16-bit, loop points are converted from bytes to samples
        sp.loop_start = Math.floor(sp.loop_start / 2);
        sp.loop_end = Math.floor(sp.loop_end / 2);
      } else { // 8-bit, convert to Float32
        sp.data = new Float32Array(bytesToRead + 2); // +2 for guard samples
        let ptr = offset;
        for (let s = 0; s < bytesToRead; s++) {
          let val;
          if (sp.modes & MODES_UNSIGNED) { // unsigned
            val = dv.getUint8(ptr) - 128;
          } else { // signed
            val = dv.getInt8(ptr);
          }
          sp.data[s] = val / 128.0;
          ptr++;
        }
        sp.data_length = bytesToRead; // Store sample count, not bytes
        // For 8-bit, loop points in bytes are the same as in samples. No conversion needed.
      }

      // Convert sample count to fixed-point length
      sp.data_length <<= 12; // FRACTION_BITS
      // CRITICAL FIX: Advance offset by the number of bytes read for the sample data
      offset += bytesToRead; 
      inst.sample.push(sp);
      console.groupEnd();
    }
    
    console.groupEnd();
    return inst;
  }
}
