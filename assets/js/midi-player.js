import { MidiSynth } from './audio.js';

/**
 * PlanetMidi - A comprehensive MIDI player class that wraps the MidiSynth engine.
 * It handles UI interactions, file loading, playback controls, and callbacks.
 *
 * Public Methods:
 * - constructor(options)
 * - async load(midiSource, name)
 * - async play()
 * - async resumeContext()
 * - pause()
 * - resume()
 * - stop()
 * - seek(timeInSeconds)
 * - setVolume(volume)
 * - async renderOffline()
 */
class PlanetMidi {
  constructor(options) {
    // Instance #1: Untuk pemutaran utama dan render offline
    this.synth = new MidiSynth({
      audioContext: options.audioContext,
      timidityCfg: options.timidityCfg,
      patchUrlBase: options.patchUrlBase,
      sampleRate: options.sampleRate,
      bufferSize: options.bufferSize,
    });

    // Instance #2: Khusus untuk "test sound" agar tidak ada konflik
    this.testSynth = new MidiSynth({
      timidityCfg: options.timidityCfg,
      patchUrlBase: options.patchUrlBase,
      sampleRate: options.sampleRate,
      bufferSize: options.bufferSize,
    });

    this.isSeeking = false;
    this.parsedData = null;

    // Link UI elements from options
    this.ui = {
      uploadInput: document.getElementById(options.uploadInputId),
      fileNameDisplay: document.getElementById(options.fileNameDisplayId),
      btnPlay: document.getElementById(options.btnPlayId),
      btnPause: document.getElementById(options.btnPauseId),
      btnStop: document.getElementById(options.btnStopId),
      statusText: document.getElementById(options.statusTextId),
      infoPanel: document.getElementById(options.infoPanelId),
      seekSlider: document.getElementById(options.seekSliderId),
      btnTest: document.getElementById(options.btnTestId),
      // Sound Preview UI
      previewChannel: document.getElementById('preview-channel'),
      previewInstrument: document.getElementById('preview-instrument'),
      previewPitch: document.getElementById('preview-pitch'),
      previewVelocity: document.getElementById('preview-velocity'),
      previewPan: document.getElementById('preview-pan'),
      btnNoteOn: document.getElementById('btn-noteon'),
      btnNoteOff: document.getElementById('btn-noteoff'),
    };

    this._createExtraControls();
    this._populatePreviewControls();
    this._setupCallbacks();
    this._setupEventListeners();
  }

  _createExtraControls() {
    // Create and append offline render button
    const btnRender = document.createElement('button');
    btnRender.id = 'btn-render-offline';
    btnRender.className = 'control-btn';
    btnRender.textContent = 'Offline Render (WAV)';
    btnRender.disabled = true;
    this.ui.btnRender = btnRender;
    this.ui.btnPlay.parentElement.appendChild(btnRender);

    // Create and append volume slider
    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.min = 0;
    volumeSlider.max = 1;
    volumeSlider.step = 0.01;
    volumeSlider.value = 1;
    volumeSlider.title = "Master Volume";
    volumeSlider.style.width = '100px';
    volumeSlider.style.marginLeft = '20px';
    this.ui.volumeSlider = volumeSlider;
    this.ui.btnPlay.parentElement.appendChild(volumeSlider);
  }
  
  _createTrackSelector() {
    const trackSelector = document.createElement('div');
    trackSelector.id = 'track-selector';
    trackSelector.className = 'track-selector-panel glass-panel';
    trackSelector.style.maxHeight = '150px'; // Set a max height
    trackSelector.style.overflowY = 'auto'; // Enable vertical scroll
    this.ui.infoPanel.insertAdjacentElement('afterend', trackSelector);
  }

  _populatePreviewControls() {
    // Populate channels 0-15
    for (let i = 0; i < 16; i++) {
      const option = new Option(i === 9 ? `Channel ${i} (Drums)` : `Channel ${i}`, i);
      this.ui.previewChannel.add(option);
    }

    // Populate instruments 0-127
    // A real app would use GM instrument names here.
    for (let i = 0; i < 128; i++) {
      const option = new Option(`Program ${i}`, i);
      this.ui.previewInstrument.add(option);
    }
  }

  _setupCallbacks() {
    this.synth.onEnded = () => {
      this.ui.statusText.textContent = "Finished playing.";
      this.ui.btnPlay.textContent = "Play";
      this.ui.btnPlay.disabled = false;
      this.ui.btnPause.disabled = true;
      this.ui.btnStop.disabled = true;
      this.ui.seekSlider.value = 100;
    };

    this.synth.onInstrumentLoading = (loaded, total, path) => {
      if (total > 0) {
        const percent = Math.round((loaded / total) * 100);
        this.ui.statusText.textContent = `Loading: ${path} (${percent}%)`;
      }
    };

    this.synth.onInstrumentLoaded = (count) => {
      this.ui.statusText.textContent = `Ready! (${count} instruments loaded).`;
    };

    this.synth.onPlaying = (tick, seconds) => {
      if (this.isSeeking) return;
      const pct = (seconds / this.synth.duration) * 100;
      this.ui.seekSlider.value = Math.min(100, pct);
    };

    this.synth.onRenderProgress = (pct) => {
      this.ui.statusText.textContent = `Offline Rendering... ${Math.round(pct * 100)}%`;
    };

    this.synth.onInstrumentLoading = (loaded, total, path) => {
      console.log([loaded, total, path]);
    };
  }

  _setupEventListeners() {
    if (this.ui.btnTest) {
      this._createTrackSelector();
      this.ui.btnTest.addEventListener('click', async () => {
        const testFile = 'Tenggelam Ke Dalam Inti Matahari.mid';
        await this.resumeContext(); // Resume on first user interaction
        await this.load(testFile, testFile);
      });
    }

    this.ui.uploadInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await this.resumeContext(); // Resume on first user interaction
      await this.load(file, file.name);
    });

    this.ui.btnPlay.addEventListener('click', () => this.play());
    this.ui.btnPause.addEventListener('click', () => this.pause());
    this.ui.btnStop.addEventListener('click', () => this.stop());

    this.ui.seekSlider.addEventListener('mousedown', () => this.isSeeking = true);
    this.ui.seekSlider.addEventListener('touchstart', () => this.isSeeking = true, { passive: true });
    this.ui.seekSlider.addEventListener('change', () => {
      this.isSeeking = false;
      if (!this.synth.song) return;
      const timeInSeconds = (this.ui.seekSlider.value / 100) * this.synth.duration;
      this.seek(timeInSeconds);
    });
    this.ui.seekSlider.addEventListener('mouseup', () => this.isSeeking = false);

    this.ui.volumeSlider.addEventListener('input', (e) => this.setVolume(e.target.value));

    this.ui.btnRender.addEventListener('click', () => this.renderOffline());

    // Sound Preview Listeners
    this.ui.btnNoteOn.addEventListener('click', async () => {
      await this.resumeTestContext(); // Gunakan konteks audio dari instance testSynth
      const channel = parseInt(this.ui.previewChannel.value, 10);
      const program = parseInt(this.ui.previewInstrument.value, 10);
      const pitch = parseInt(this.ui.previewPitch.value, 10);
      const velocity = parseInt(this.ui.previewVelocity.value, 10);
      const pan = parseInt(this.ui.previewPan.value, 10);

      // For non-drum channels, set the instrument first
      if (channel !== 9) {
        await this.testSynth.programChange(channel, program); // Gunakan testSynth
      }
      this.testSynth.noteOn(channel, pitch, velocity, pan); // Gunakan testSynth dengan pan yang benar
    });

    this.ui.btnNoteOff.addEventListener('click', () => {
      const channel = parseInt(this.ui.previewChannel.value, 10);
      const pitch = parseInt(this.ui.previewPitch.value, 10);
      this.testSynth.noteOff(channel, pitch); // Gunakan testSynth
    });
  }

  // --- Public API ---

  async load(midiSource, name) {

    // Stop MIDI
    this.stop();

    // Update UI


    this.ui.fileNameDisplay.textContent = name;
    this.ui.statusText.textContent = "Parsing MIDI file...";
    this.ui.btnPlay.disabled = true;
    this.ui.btnPause.disabled = true;
    this.ui.btnStop.disabled = true;
    this.ui.btnRender.disabled = true;
    this.ui.infoPanel.innerHTML = "";

    try {
      // Clear previous track selector
      const trackSelector = document.getElementById('track-selector');
      if (trackSelector) {
        // Also hide/clear render options panel
        const renderOptionsPanel = document.getElementById('render-options-panel');
        if (renderOptionsPanel) {
          renderOptionsPanel.style.display = 'none';
        }

        trackSelector.innerHTML = `
          <h3>Render Specific Tracks (Stems)</h3>
          <label style="display: block; font-weight: bold; margin-bottom: 5px;">
            <input type="checkbox" id="check-all-tracks"> Check All
          </label>
        `;
        trackSelector.style.display = 'none';

        const checkAll = trackSelector.querySelector('#check-all-tracks');
        checkAll.addEventListener('change', (e) => {
          const isChecked = e.target.checked;
          trackSelector.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            if (cb.id !== 'check-all-tracks') {
              cb.checked = isChecked;
            }
          });
        });
      }

      this.parsedData = await this.synth.load(midiSource);

      if (!this.parsedData || this.parsedData.count === 0) {
        this.ui.statusText.textContent = "Error parsing MIDI file.";
        return;
      }

      this.ui.infoPanel.innerHTML = `
        <strong>Track Info:</strong><br>
        Events: ${this.parsedData.count}<br>
        Total Samples: ${this.parsedData.samples} @ 44.1kHz<br>
        Duration: ${this.synth.duration.toFixed(2)} seconds
      `;

      this.ui.btnPlay.disabled = false;
      this.ui.btnRender.disabled = false;
      this.ui.seekSlider.value = 0;

      // Populate track selector
      if (trackSelector) {
        const tracks = new Set(this.parsedData.events.map(e => e.track));
        tracks.forEach(trackNum => {
          if (trackNum === undefined || trackNum === null) return;
          const trackName = this.synth.song.track_names[trackNum] || `Track ${trackNum}`;
          const label = document.createElement('label');
          label.style.display = 'block'; // Style for vertical layout
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = trackNum;
          label.appendChild(checkbox);
          label.appendChild(document.createTextNode(` ${trackName}`));
          trackSelector.appendChild(label);
        });

        const renderOptionsPanel = document.getElementById('render-options-panel');
        if (renderOptionsPanel) {
          renderOptionsPanel.style.display = 'block';
        }

        trackSelector.style.display = 'block';
      }

    } catch (err) {
      console.error(err);
      this.ui.statusText.textContent = "Exception while loading.";
    }
  }

  async resumeContext() {
    if (!this.synth.ctx) {
      this.synth.init(false, 44100);
    }
    if (this.synth.ctx && this.synth.ctx.state === 'suspended') {
      return this.synth.ctx.resume();
    }
  }

  // Fungsi baru untuk memastikan konteks audio untuk testSynth berjalan
  async resumeTestContext() {
    if (!this.testSynth.ctx) {
      this.testSynth.init(false);
    }
    if (this.testSynth.ctx && this.testSynth.ctx.state === 'suspended') {
      return this.testSynth.ctx.resume();
    }
  }

  async play() {
    if (this.synth.isPlaying && !this.synth.isPaused) {
      this.pause();
    } else if (this.synth.isPaused) {
      this.resume();
    } else {
      this.ui.statusText.textContent = "Playing...";
      this.ui.btnPlay.textContent = "Pause";
      this.ui.btnPlay.disabled = true; // Disable until playback starts
      await this.synth.play(0); // Play from the beginning
      this.ui.btnPlay.disabled = false;
      this.ui.btnStop.disabled = false;
      this.ui.btnPause.disabled = false;
      this.ui.seekSlider.disabled = false;
    }
  }

  pause() {
    if (!this.synth.isPlaying || this.synth.isPaused) return;
    this.synth.pause();
    this.ui.statusText.textContent = "Paused.";
    this.ui.btnPlay.textContent = "Resume";
  }

  resume() {
    if (!this.synth.isPaused) return;
    this.synth.resume();
    this.ui.statusText.textContent = "Playing...";
    this.ui.btnPlay.textContent = "Pause";
  }

  stop() {
    this.synth.stop();
    this.ui.statusText.textContent = "Stopped.";
    this.ui.btnPlay.textContent = "Play";
    this.ui.btnStop.disabled = true;
    this.ui.btnPlay.disabled = false;
    this.ui.btnPause.disabled = true;
    this.ui.seekSlider.disabled = true;
    this.ui.seekSlider.value = 0;
  }

  seek(timeInSeconds) {
    this.synth.seek(timeInSeconds);
  }

  setVolume(volume) {
    this.synth.setVolume(volume);
  }

  async renderOffline() {
    this.ui.statusText.textContent = "Offline Rendering... 0%";
    this.ui.btnPlay.disabled = true;
    this.ui.btnRender.disabled = true;

    const selectedTracks = [];
    const trackSelector = document.getElementById('track-selector');
    if (trackSelector) {
      trackSelector.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
        selectedTracks.push(parseInt(cb.value, 10));
      });
    }

    const isSpatial = document.getElementById('render-spatial3d')?.checked || false;
    const isMono = document.getElementById('render-mono')?.checked || false;

    const renderOptions = { offline: true, tracksToRender: selectedTracks, spatial3d: isSpatial, isMono: isMono };

    const renderedBuffer = await this.synth.play(0, renderOptions);
    this.ui.statusText.textContent = "Render Complete! Downloading...";

    const wavBlob = this.synth.audioBufferToWav(renderedBuffer);
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = 'rendered_midi.wav';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 100);

    this.ui.btnPlay.disabled = false;
    this.ui.btnRender.disabled = false;
  }

}

// Initialize the player when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Example of providing an external AudioContext:
  // const myAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  // new PlanetMidi({ audioContext: myAudioContext, ... });
  // new PlanetMidi({ sampleRate: 48000, bufferSize: 2048, ... });
  // new PlanetMidi({ patchUrlBase: 'https://cdn.example.com/patches/', ... });
  new PlanetMidi({
    uploadInputId: 'midi-upload',
    fileNameDisplayId: 'file-name',
    btnPlayId: 'btn-play',
    btnPauseId: 'btn-pause',
    btnStopId: 'btn-stop',
    statusTextId: 'status-text',
    infoPanelId: 'info-panel',
    seekSliderId: 'seek-slider',
    btnTestId: 'btn-test',
    sampleRate: 44100,
    bufferSize: 8192,

    timidityCfg: 'timidity.cfg',
    patchUrlBase: '././projects/Project_2_1785109247/',
  });
});
