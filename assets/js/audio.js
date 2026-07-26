import { mid_song_read_wave, note_on, note_off, finish_note } from './playmidi.js';
import { InstrumentLoader } from './instrum.js';
import { mix_voice } from './mix.js';
import { MidIStream, MidSong, ME_EOT, ME_NOTEON } from './types.js';
import { read_midi_file } from './readmidi.js';

/**
 * @class MidiSynth
 * @classdesc The core MIDI synthesis engine. It handles loading, parsing, and playback of MIDI data.
 *
 * @property {AudioContext|OfflineAudioContext|null} ctx - The Web Audio API context.
 * @property {string} patchUrlBase - The base URL for loading instrument patch files.
 * @property {boolean} isPlaying - True if audio is currently being rendered.
 * @property {boolean} isPaused - True if playback is paused.
 * @property {MidSong|null} song - The internal song object being played.
 *
 * @method constructor(options={})
 * @method async load(midi) - Loads and parses a MIDI file.
 * @method init(offline) - Initializes the audio context.
 * @method async play(offset=0, options={}) - Starts playback.
 * @method async loadAndPlay(midi, offset=0, options={}) - Loads and starts playback.
 * @method stop() - Stops playback.
 * @method pause() - Pauses playback.
 * @method resume() - Resumes playback.
 * @method seek(timeInSeconds)
 * @method goTo(ticks)
 * @method setVolume(volume)
 * @method audioBufferToWav(buffer) - Converts an AudioBuffer to a WAV Blob.
 * @method async programChange(channel, program)
 * @method async noteOn(channel, note, velocity)
 * @method noteOff(channel, note)
 *
 * @callback onPlay - Called when playback starts.
 * @callback onPlaying - (tick, elapsed) - Called frequently during playback for UI updates.
 * @callback onPause - Called when playback is paused.
 * @callback onResume - Called when playback is resumed.
 * @callback onStop - Called when playback is stopped.
 * @callback onEnded - Called when the song finishes.
 * @callback onSeek - (sample, time) - Called after a seek operation.
 * @callback onMidiLoading - (midi) - Called when MIDI loading begins.
 * @callback onMidiLoaded - (midi) - Called when MIDI loaded.
 * @callback onInstrumentLoading - (loaded, total, pathToLoad) - Called during instrument loading.
 * @callback onInstrumentLoaded - (count) - Called after all instruments are loaded.
 * @callback onRenderProgress - (percent, isSpatial, trackId, trackName, totalTracks) - Called during offline rendering.
 * @callback onMIDIEvent - (event) - Called for each MIDI event during playback.
 */
export class MidiSynth {
  #maxTick = 0;
  #duration = 0;
  #animationFrameId = null;

  /**
   * @constructor
   * @param {object} [options={}] - Configuration options for the synthesizer.
   * @param {AudioContext} [options.audioContext] - An external AudioContext to use. If not provided, a new one will be created.
   * @param {number} [options.sampleRate=44100] - The desired sample rate. Ignored if an external audioContext is provided.
   * @param {number} [options.bufferSize=4096] - The audio processing buffer size.
   * @param {string} [options.timidityCfg='./timidity.cfg' - The timidity.cfg URL]
   * @param {string} [options.patchUrlBase='./freepats/'] - The base URL to load instrument patch files from.
   */
  constructor(options = {}) {
    this.ctx = options.audioContext || null;
    if (this.ctx) {
      // If an external context is provided, its sampleRate is the source of truth.
      this.sampleRate = this.ctx.sampleRate;
      if (options.sampleRate && options.sampleRate !== this.sampleRate) {
        console.warn(`MidiSynth: Provided sampleRate (${options.sampleRate}) is ignored because an external AudioContext with a sampleRate of ${this.sampleRate} was provided.`);
      }
    } else {
      this.sampleRate = options.sampleRate || 44100;
    }
    this.bufferSize = options.bufferSize || 4096;
    this.timidityCfg = options.timidityCfg;
    this.patchUrlBase = options.patchUrlBase;
    this.externalContext = !!options.audioContext;
    this.loader = null;
    this.scriptNode = null;
    this.gainNode = null;
    this.reverbNode = null;
    this.chorusNode = null;
    this.reverbSend = null;
    this.chorusSend = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.song = null;
    this.parsedData = null;
    this.testSoundSong = null; // A song object for live playback
    this.startTime = 0;
    
    if (this.externalContext) {
      this.gainNode = this.ctx.createGain();
      this.gainNode.connect(this.ctx.destination);
      this.#createEffectsNodes();
    }

    // Callbacks
    this.onPlay = null;
    this.onPlaying = null;
    this.onPause = null;
    this.onResume = null;
    this.onStop = null;
    this.onEnded = null;
    this.onSeek = null;
    this.onMidiLoading = null;
    this.onMidiLoaded = null;
    this.onInstrumentLoading = null;
    this.onInstrumentLoaded = null;
    this.onRenderProgress = null;
    this.onMIDIEvent = null;
  }

  #createEffectsNodes() {
    if (!this.ctx) return;

    // Reverb (using a simple generated impulse response)
    this.reverbNode = this.ctx.createConvolver();
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0; // Default to dry
    this.reverbSend.connect(this.reverbNode);
    this.reverbNode.connect(this.gainNode); // Reverb returns to master gain

    // Create a simple impulse response for the reverb
    const impulseLength = this.sampleRate * 2; // 2 seconds reverb
    const impulse = this.ctx.createBuffer(2, impulseLength, this.sampleRate);
    const impulseL = impulse.getChannelData(0);
    const impulseR = impulse.getChannelData(1);
    for (let i = 0; i < impulseLength; i++) {
      impulseL[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / impulseLength, 2.5);
      impulseR[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / impulseLength, 2.5);
    }
    this.reverbNode.buffer = impulse;

    // Chorus
    this.chorusNode = this.ctx.createDelay(0.1); // Max delay of 0.1s
    this.chorusNode.delayTime.value = 0.025; // 25ms delay
    const chorusLFO = this.ctx.createOscillator();
    chorusLFO.type = 'sine';
    chorusLFO.frequency.value = 5; // 5Hz LFO
    const chorusLFOgain = this.ctx.createGain();
    chorusLFOgain.gain.value = 0.005; // 5ms depth
    this.chorusSend = this.ctx.createGain();
    this.chorusSend.gain.value = 0; // Default to dry
    chorusLFO.connect(chorusLFOgain);
    chorusLFOgain.connect(this.chorusNode.delayTime);
    this.chorusSend.connect(this.chorusNode);
    this.chorusNode.connect(this.gainNode);
    chorusLFO.start();
  }

  async loadAndPlay(midi, offset = 0, options = {})
  {
    await this.load(midi);
    await this.play(offset, options);
    return this.parsedData;
  }

  async load(midi) {
    this.onMidiLoading?.(midi);
    const stream = new MidIStream(await this._midiToAb(midi));
    const song = new MidSong();
    song.rate = this.sampleRate;
    this.parsedData = read_midi_file(stream, song);
    this.song = this.parsedData.song;
    
    this.#duration = this.parsedData.samples / this.sampleRate;
    this.#maxTick = this.parsedData.events[this.parsedData.events.length - 1].time;

    if (!this.loader) this.loader = new InstrumentLoader(this.song, this.patchUrlBase);
    else {
      // PASTIKAN LOADER MENGGUNAKAN OBJEK SONG YANG BARU
      this.loader.song = this.song;
    }
    this.loader.onProgress = this.onInstrumentLoading;
    await this.loader.loadConfig(this.timidityCfg);
    const loadedCount = await this.loader.loadMissingInstruments();
    this.onInstrumentLoaded?.(loadedCount);

    // Also prepare a song object for live playback if it doesn't exist
    if (!this.testSoundSong) {
      this.testSoundSong = this.song;
    }
    this.onMidiLoaded?.(midi);
    return this.parsedData;
  }

  get duration() {
    return this.#duration;
  }

  get maxTick() {
    return this.#maxTick;
  }

  init(offline) {
    if (this.externalContext) {
      // If context is external, we assume it's already initialized and running.
      // We just need to make sure our nodes are set up.
      if (!this.gainNode) {
          this.gainNode = this.ctx.createGain();
          this.gainNode.connect(this.ctx.destination);
      }
      return;
    }

    if (this.ctx && this.ctx.state !== 'closed') {
      if (offline === (this.ctx instanceof OfflineAudioContext)) {
        return; // Already initialized correctly
      }
      this.ctx.close();
    }
    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }
    
    if (offline) {
      // Offline context creation is deferred to play() where we know the total length.
    } else {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContext({ sampleRate: this.sampleRate });
      this.gainNode = this.ctx.createGain();
      this.#createEffectsNodes();
      this.gainNode.connect(this.ctx.destination);
    }
  }

  async play(offset = 0, options = {}) {
    const {
      offline = false,
      spatial3d = false,
      tracksToRender = null,
      isMono = false,
    } = options;

    // Spatial audio cannot be mono, so spatial3d takes precedence.
    if (spatial3d && isMono) {
      console.warn("isMono=true is ignored when spatial3d=true, as spatial audio requires stereo output.");
      options.isMono = false; // Correct the option for later use
    }

    if (!this.parsedData) throw new Error("No MIDI data loaded. Call load() first.");
    
    if (this.isPaused) return this.resume();

    if (offset > 0) {
      this.seek(offset);
    }

    this.init(offline);
    if (!offline) {
      this.onPlay?.(this.parsedData, this.sampleRate, offline);
    }

    let eventsToPlay = this.parsedData.events;

    // If rendering in mono, force all pan events to center.
    if (offline && options.isMono) {
      console.log("Forcing all pan events to center for mono rendering.");
      eventsToPlay.forEach(ev => {
        if (ev.type === 5 /* ME_PAN */) ev.a = 64;
      });
    }

    // If rendering specific tracks, filter the event list.
    if (offline && tracksToRender && tracksToRender.length > 0) {
      // Find the track containing meta-events (like tempo) but no notes.
      // This is typically track 0 in Format 1 MIDI files.
      const allTracks = new Set(this.parsedData.events.map(e => e.track));
      let metaTrack = -1;
      for (const trackNum of allTracks) {
        if (trackNum === undefined) continue;
        const trackEvents = this.parsedData.events.filter(e => e.track === trackNum);
        if (trackEvents.length > 0 && !trackEvents.some(e => e.type === ME_NOTEON && e.b > 0)) {
          metaTrack = trackNum;
          break;
        }
      }

      console.log(`Rendering only tracks: ${tracksToRender.join(', ')}` + (metaTrack !== -1 ? ` (and meta track ${metaTrack})` : ''));
      const trackSet = new Set(tracksToRender);
      eventsToPlay = this.parsedData.events.filter(ev => trackSet.has(ev.track) || (metaTrack !== -1 && ev.track === metaTrack) || ev.type === ME_EOT);
      // Re-link the filtered events
      for(let i=0; i < eventsToPlay.length - 1; i++) {
        eventsToPlay[i].next = eventsToPlay[i+1];
      }
    }

    // Reset song state for playback
    this.song.events = eventsToPlay;
    this.song.current_event = eventsToPlay[0];
    this.song.samples = this.parsedData.samples;
    this.song.playing = 1;
    if (offset === 0) this.song.current_sample = 0;
    this.song.buffer_size = this.bufferSize;
    this.song.control_ratio = Math.floor(this.sampleRate / 1000);
    if (this.song.control_ratio < 1) this.song.control_ratio = 1;
    this.song.resample_buffer = new Float32Array(this.song.buffer_size * 2);
    this.song.common_buffer = new Int32Array(this.song.buffer_size * 2);
    this.song.master_volume = 1.0; // Ensure master volume is reset
    
    if (!offline && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    
    window._debugAudioPlay = 0;
    this.isPlaying = true;
    this.isPaused = false;
    this.startTime = this.ctx.currentTime;
    
    
    if (offline) {
      return new Promise(async (resolve) => {
        // --- 3D Spatial Audio Rendering Logic ---
        if (spatial3d) {
          // 1. Pre-scan for relevant spatial CC events
          const hasSpatialCCs = this.parsedData.events.some(ev => 
            (ev.type === 20 || ev.type === 21) && ev.a !== 64
          );

          if (hasSpatialCCs) {
            console.log("Starting 3D Spatial Audio offline render.");
            const totalSamples = this.song.samples;
            const offlineCtx = new OfflineAudioContext(2, totalSamples, this.sampleRate);

            const usedChannels = [...new Set(this.parsedData.events.map(e => e.channel))].filter(ch => ch !== undefined && ch !== null);
            const totalChannelsToRender = usedChannels.length;
            let channelsRendered = 0;

            // 2. Render each channel separately
            for (const ch of usedChannels) {
              channelsRendered++;
              this.onRenderProgress?.(channelsRendered / totalChannelsToRender, true, ch, `Channel ${ch}`, totalChannelsToRender);

              // Create a temporary song object for single-channel rendering
              const singleChannelSong = JSON.parse(JSON.stringify(this.song));
              singleChannelSong.events = this.parsedData.events;
              singleChannelSong.current_event = this.parsedData.events[0];
              singleChannelSong.playing = 1;
              singleChannelSong.buffer_size = this.bufferSize;
              singleChannelSong.control_ratio = this.song.control_ratio;
              singleChannelSong.resample_buffer = new Float32Array(this.bufferSize * 2);
              singleChannelSong.common_buffer = new Int32Array(this.bufferSize * 2);

              // Mute all other channels
              for (let i = 0; i < 16; i++) {
                if (i !== ch) singleChannelSong.channel[i].volume = 0;
              }

              // Render this single channel to a mono buffer
              const channelBuffer = new Float32Array(totalSamples);
              let rendered = 0;
              while (rendered < totalSamples) {
                const toRender = Math.min(this.bufferSize, totalSamples - rendered);
                const actualRendered = mid_song_read_wave(singleChannelSong, channelBuffer, rendered, toRender);
                rendered += actualRendered;
                if (actualRendered === 0 || !singleChannelSong.playing) break;
              }

              // If the channel produced sound, spatialize it
              if (channelBuffer.some(s => s !== 0)) {
                const sourceNode = offlineCtx.createBufferSource();
                const audioBuffer = offlineCtx.createBuffer(1, totalSamples, this.sampleRate);
                audioBuffer.copyToChannel(channelBuffer, 0);
                sourceNode.buffer = audioBuffer;

                const panner = offlineCtx.createPanner();
                panner.panningModel = 'HRTF';
                panner.distanceModel = 'inverse';

                // 3. Automate panner position based on CC events for this channel
                let lastX = 0.5, lastY = 0.5, lastZ = 0.5;
                panner.positionX.setValueAtTime((lastX - 0.5) * 10, 0);
                panner.positionY.setValueAtTime((lastY - 0.5) * 10, 0);
                panner.positionZ.setValueAtTime((lastZ - 0.5) * 10, 0);

                this.parsedData.events.forEach(ev => {
                  if (ev.channel === ch) {
                    const time = ev.time / this.sampleRate;
                    if (ev.type === 5 /* ME_PAN */) lastX = ev.a / 127.0;
                    if (ev.type === 20) lastY = ev.a / 127.0;
                    if (ev.type === 21) lastZ = ev.a / 127.0;
                    panner.positionX.linearRampToValueAtTime((lastX - 0.5) * 10, time);
                    panner.positionY.linearRampToValueAtTime((lastY - 0.5) * 10, time);
                    panner.positionZ.linearRampToValueAtTime((lastZ - 0.5) * 10, time);
                  }
                });

                sourceNode.connect(panner);
                panner.connect(offlineCtx.destination);
                sourceNode.start(0);
              }
            }
            
            const renderedBuffer = await offlineCtx.startRendering();
            this.onRenderProgress?.(1.0, true, totalChannelsToRender, "Mixing Down", totalChannelsToRender);
            return resolve(renderedBuffer);
          }
        }

        // --- Fallback to normal stereo rendering ---
        const totalSamples = this.song.samples;
        const numberOfChannels = options.isMono ? 1 : 2;
        // Correctly create the OfflineAudioContext with the full song length.
        const offlineCtx = new OfflineAudioContext(numberOfChannels, totalSamples, this.sampleRate);
        const outBuffer = offlineCtx.createBuffer(numberOfChannels, totalSamples, this.sampleRate);
        let leftOut = null, rightOut = null;
        if (numberOfChannels > 0) leftOut = outBuffer.getChannelData(0);
        if (numberOfChannels > 1) rightOut = outBuffer.getChannelData(1);
        
        // We will render to a temporary interleaved Float32Array
        const tempInterleaved = new Float32Array(totalSamples * 2);
        
        let rendered = 0;
        const chunkSize = this.sampleRate; // 1 second chunks
        
        while (rendered < totalSamples) {
          const toRender = Math.min(chunkSize, totalSamples - rendered);
          const actualRendered = mid_song_read_wave(this.song, tempInterleaved, rendered * 2, toRender);
          rendered += actualRendered;
          
          this.onRenderProgress?.(rendered / totalSamples, false, null, null, null);

          if (rendered % (chunkSize * 5) === 0) await new Promise(r => setTimeout(r, 0)); // Yield to UI less often
          
          if (actualRendered === 0 || !this.song.playing) break;
        }
        
        // De-interleave
        if (options.isMono) {
          const monoOut = outBuffer.getChannelData(0);
          for (let i = 0; i < totalSamples; i++) {
            // Average left and right channels for a mono mixdown
            monoOut[i] = (tempInterleaved[i * 2] + tempInterleaved[i * 2 + 1]) / 2;
          }
        } else {
          for (let i = 0; i < totalSamples; i++) {
            leftOut[i] = tempInterleaved[i * 2];
            rightOut[i] = tempInterleaved[i * 2 + 1];
          }
        }
        
        this.onRenderProgress?.(1.0, false, null, null, null);
        resolve(outBuffer);
      });
    } else {
      this.scriptNode = this.ctx.createScriptProcessor(this.bufferSize, 2, 2);
      
      const tempInterleaved = new Float32Array(this.bufferSize * 2);
      
      this.scriptNode.onaudioprocess = (audioProcessingEvent) => {
        try {
          const outputBuffer = audioProcessingEvent.outputBuffer;
          const leftOut = outputBuffer.getChannelData(0);
          const rightOut = outputBuffer.getChannelData(1);
          const frames = outputBuffer.length;

          if (!this.isPlaying || this.isPaused || !this.song.playing) {
            leftOut.fill(0);
            rightOut.fill(0);
            return;
          }
          
          const rendered = mid_song_read_wave(this.song, tempInterleaved, 0, frames, this.onMIDIEvent);
          
          if (rendered === 0) {
            this.isPlaying = false;
            leftOut.fill(0);
            rightOut.fill(0);
            return;
          }
          
          // De-interleave
          let maxVal = 0;
          for (let i = 0; i < frames; i++) {
            leftOut[i] = tempInterleaved[i * 2];
            rightOut[i] = tempInterleaved[i * 2 + 1];
            if (Math.abs(leftOut[i]) > maxVal) maxVal = Math.abs(leftOut[i]);
          }
          if (maxVal > 0.01 && !window._firstLoudSound) {
            window._firstLoudSound = true;
          }
          if (maxVal > 0 && !window._firstSoundPlayed) {
            window._firstSoundPlayed = true;
          }
        } catch (err) {
          console.error("AudioProcess Error: ", err);
        }
      };
      
      this.scriptNode.connect(this.gainNode); // Dry signal
      this.scriptNode.connect(this.reverbSend); // Wet signal to Reverb
      this.scriptNode.connect(this.chorusSend); // Wet signal to Chorus

      this.#startUiUpdateLoop();
      return null;
    }
  }

  stop() {
    this.isPlaying = false;
    this.#stopUiUpdateLoop();
    this.isPaused = false;
    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }
    this.testSoundSong = null; // Clear test sound song state
    if (!this.externalContext) {
      if (this.ctx && this.ctx.state !== 'closed') {
        this.ctx.close();
        this.ctx = null;
      }
    }
    this.onStop?.();
  }

  pause() {
    if (!this.isPlaying || this.isPaused) return;
    this.isPaused = true;
    this.#stopUiUpdateLoop();
    this.ctx.suspend();
    this.onPause?.();
  }

  resume() {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.ctx.resume();
    this.#startUiUpdateLoop();
    this.onResume?.();
  }

  #ticksToSamples(targetTicks) {
    if (!this.parsedData || !this.parsedData.rawEvents) return 0;

    let tempo = 500000; // Default tempo: 120 BPM (500,000 microseconds per quarter note)
    const divisions = this.parsedData.divisions;

    let currentSample = 0;
    let currentTick = 0;
    let sample_increment = 0;
    let sample_correction = 0;
    let sample_cum = 0;

    const compute_inc = () => {
      const a = (tempo * this.sampleRate * (65536.0 / 1000000.0)) / divisions;
      sample_correction = Math.floor(a) & 0xFFFF;
      sample_increment = Math.floor(a) >> 16;
    };
    compute_inc();

    for (const ev of this.parsedData.rawEvents) {
      if (ev.time >= targetTicks) break;

      const dt = ev.time - currentTick;
      if (dt > 0) {
        const samples_to_do = sample_increment * dt;
        sample_cum += sample_correction * dt;
        currentSample += samples_to_do + ((sample_cum >> 16) & 0xFFFF);
        sample_cum &= 0x0000FFFF;
      }

      if (ev.type === 10 /* ME_TEMPO */) {
        tempo = ev.channel + ev.b * 256 + ev.a * 65536;
        compute_inc();
      }
      currentTick = ev.time;
    }
    return currentSample;
  }

  #goToSample(targetSample) {
    if (!this.song) return;

    const timeInSeconds = targetSample / this.sampleRate;
    this.song.current_sample = targetSample;
    if (this.ctx) {
      this.startTime = this.ctx.currentTime - timeInSeconds;
    }

    // Fast-forward event loop pointer
    let ev = this.parsedData.events[0];
    while (ev && ev.time < targetSample) {
      ev = ev.next;
    }
    this.song.current_event = ev;

    // Reset all channel sustains before turning off notes
    for (let i = 0; i < 16; i++) {
      this.song.channel[i].sustain = 0;
    }

    // Properly turn off all currently playing notes to prevent stacking.
    for (let i = 0; i < this.song.voices; i++) {
      const voice = this.song.voice[i];
      if (voice.status === 1 /* VOICE_ON */ || voice.status === 2 /* VOICE_SUSTAINED */) {
        finish_note(this.song, i);
      }
    }
    this.onSeek?.(targetSample, timeInSeconds);
  }

  goTo(midiTicks) {
    const targetSample = this.#ticksToSamples(midiTicks);
    this.#goToSample(targetSample);
  }

  seek(timeInSeconds) {
    const targetSample = Math.floor(timeInSeconds * this.sampleRate);
    this.#goToSample(targetSample);
  }

  setVolume(volume) {
    if (this.gainNode) {
      this.gainNode.gain.setValueAtTime(volume, this.ctx.currentTime);
    }
    // Also set master_volume for offline rendering and internal calculations
    if (this.song) {
      this.song.master_volume = volume;
    }
  }

  setReverb(level) { // level 0-127
    if (this.reverbSend) {
      this.reverbSend.gain.setTargetAtTime(level / 127, this.ctx.currentTime, 0.01);
    }
  }

  setChorus(level) { // level 0-127
    if (this.chorusSend) {
      this.chorusSend.gain.setTargetAtTime(level / 127, this.ctx.currentTime, 0.01);
    }
  }

  // --- Test Sound API ---

  async _initForLivePlayback() {
    if (this.testSoundSong) return; // Already initialized

    console.log("Initializing engine for live playback...");
    const song = new MidSong();
    song.rate = this.sampleRate;
    // Initialize buffers and control ratios needed for mixing
    song.buffer_size = this.bufferSize;
    song.control_ratio = Math.floor(this.sampleRate / 1000);
    if (song.control_ratio < 1) song.control_ratio = 1;
    song.resample_buffer = new Float32Array(this.bufferSize * 2);
    song.common_buffer = new Int32Array(this.bufferSize * 2);
    this.testSoundSong = song;

    if (!this.loader) {
      this.loader = new InstrumentLoader(this.testSoundSong, this.patchUrlBase);
      await this.loader.loadConfig(this.timidityCfg);
    }
  }

  async _ensureAudioIsRunning() {
    if (this.isPlaying) return; // Already running

    await this._initForLivePlayback();

    if (!this.ctx) {
      this.init(false);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    if (!this.scriptNode) {
      // Start the script processor to generate audio, even if no song is playing
      this.scriptNode = this.ctx.createScriptProcessor(this.bufferSize, 2, 2);
      this.scriptNode.onaudioprocess = (e) => {
        if (this.isPlaying) return; // Let the main playback loop handle it
        
        // For live notes, we just need to keep the audio stream alive and mix voices
        const leftOut = e.outputBuffer.getChannelData(0);
        const rightOut = e.outputBuffer.getChannelData(1);
        const frames = e.outputBuffer.length;
        const tempInterleaved = new Float32Array(frames * 2);

        if (this.testSoundSong) {
          this.testSoundSong.common_buffer.fill(0);
          for (let i = 0; i < this.testSoundSong.voices; i++) {
            if (this.testSoundSong.voice[i].status !== 0 /* VOICE_FREE */) {
              mix_voice(this.testSoundSong, this.testSoundSong.common_buffer, i, frames);
            }
          }
          for(let i=0; i<frames*2; i++) {
            tempInterleaved[i] = this.testSoundSong.common_buffer[i] / 32768.0;
          }
        }

        for (let i = 0; i < frames; i++) {
          leftOut[i] = tempInterleaved[i * 2];
          rightOut[i] = tempInterleaved[i * 2 + 1];
        }
      };
      this.scriptNode.connect(this.gainNode); // Dry signal
      this.scriptNode.connect(this.reverbSend); // Wet signal to Reverb
      this.scriptNode.connect(this.chorusSend); // Wet signal to Chorus
    }
  }

  async noteOn(channel, note, velocity, pan = 64) {
    await this._ensureAudioIsRunning();
    // if (!this.testSoundSong) throw new Error("Engine not initialized. Call load() at least once.");
    
    // Manually trigger a PAN event to position the sound.
    // Use the provided pan value, or default to center (64).
    const panEvent = { channel, type: 5 /* ME_PAN */, a: pan, b: 0 };
    this.testSoundSong.channel[channel].panning = panEvent.a;
    
    // Manually trigger a note_on event after setting the pan
    const noteOnEvent = { channel, a: note, b: velocity };
    note_on(this.testSoundSong, noteOnEvent);
  }

  noteOff(channel, note) {
    if (!this.testSoundSong) return;

    // Manually trigger a note_off event
    const ev = { channel, a: note, b: 0 };
    note_off(this.testSoundSong, ev);
  }

  async programChange(channel, program) {
    await this._initForLivePlayback();
    
    // Set the program for the channel
    this.testSoundSong.channel[channel].program = program;
    // Trigger loading of the instrument if it's not already loaded
    await this.loader.loadSingleInstrument(program);
  }

  async _midiToAb(midi) {
    if (midi instanceof ArrayBuffer) return midi;
    if (midi instanceof Uint8Array) return midi.buffer;
    if (midi instanceof Blob) return await midi.arrayBuffer();
    if (typeof midi === 'string') {
      if (midi.startsWith('data:')) {
        return await (await fetch(midi)).arrayBuffer();
      }
      return await (await fetch(midi)).arrayBuffer();
    }
    throw new Error("Unsupported MIDI input type");
  }
  audioBufferToWav(buffer) {
    let numOfChan = buffer.numberOfChannels,
        length = buffer.length * numOfChan * 2 + 44,
        out = new ArrayBuffer(length),
        view = new DataView(out),
        pos = 0;

    function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
    function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }

    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); // file length - 8
    setUint32(0x45564157); // "WAVE"
    setUint32(0x20746d66); // "fmt " chunk
    setUint32(16); // length = 16
    setUint16(1); // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(buffer.sampleRate);
    setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2); // block-align
    setUint16(16); // 16-bit
    setUint32(0x61746164); // "data" - chunk
    setUint32(length - pos - 4); // chunk length

    const pcm16 = new Int16Array(out, 44);
    const numSamples = buffer.length;
    let pcmIdx = 0;

    if (numOfChan === 2) {
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let s = 0; s < numSamples; s++) {
        let l = left[s];
        let r = right[s];
        l = l < -1 ? -1 : (l > 1 ? 1 : l);
        r = r < -1 ? -1 : (r > 1 ? 1 : r);
        pcm16[pcmIdx++] = (l < 0 ? l * 32768 : l * 32767) | 0;
        pcm16[pcmIdx++] = (r < 0 ? r * 32768 : r * 32767) | 0;
      }
    } else {
      const mono = buffer.getChannelData(0);
      for (let s = 0; s < numSamples; s++) {
        let m = mono[s];
        m = m < -1 ? -1 : (m > 1 ? 1 : m);
        pcm16[pcmIdx++] = (m < 0 ? m * 32768 : m * 32767) | 0;
      }
    }

    return new Blob([out], { type: "audio/wav" });
  }

  // --- UI Update Loop ---

  #uiUpdateLoop() {
    if (!this.isPlaying || this.isPaused) {
      this.#animationFrameId = null;
      return;
    }
    const elapsed = this.ctx.currentTime - this.startTime;
    this.onPlaying?.(this.song?.current_sample || 0, elapsed); // Call with elapsed time and current sample position
    this.#animationFrameId = requestAnimationFrame(() => this.#uiUpdateLoop());
  }

  #startUiUpdateLoop() {
    this.#stopUiUpdateLoop(); // Ensure no multiple loops are running
    this.#animationFrameId = requestAnimationFrame(() => this.#uiUpdateLoop());
  }

  #stopUiUpdateLoop() {
    if (this.#animationFrameId) {
      cancelAnimationFrame(this.#animationFrameId);
      this.#animationFrameId = null;
    }
  }
}
