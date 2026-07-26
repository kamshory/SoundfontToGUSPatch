import { MidiSynth } from './audio.js';
import { MidInstrument, MidSample, MODES_16BIT, MODES_LOOPING, MODES_SUSTAIN, MODES_ENVELOPE } from './types.js';

class WaveformEditor {
    constructor(canvasId) {
        this.container = document.getElementById('waveform-container');
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.sampleData = null;
        this.isDrawing = false;
        this.zoomLevel = 1.0; // 1.0 = 100% zoom
        this.viewOffset = 0; // The starting sample index for the current view

        this._addEventListeners();
        this.draw(); // Initial empty draw
    }

    /**
     * Memuat data sampel baru ke editor.
     * @param {Int16Array} sampleData - Data sampel mentah.
     */
    loadSample(sampleData) {
        this.zoomLevel = 1.0;
        this.viewOffset = 0;
        this.sampleData = sampleData;
        this.updateScroller();
        this.container.querySelector('.fake-scrollbar-container').scrollLeft = 0;
        this.draw();
    }

    /**
     * Menggambar waveform ke canvas.
     */
    draw() {
        if (!this.canvas) return;
        // Canvas width now stays fixed to its container's visible width
        this.canvas.width = this.container.clientWidth;

        const width = this.canvas.width;
        const height = this.canvas.height;
        const middle = height / 2;

        // Clear canvas
        this.ctx.clearRect(0, 0, width, height); // Clear the entire canvas
        
        // Draw center line
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(0, middle);
        this.ctx.lineTo(width, middle);
        this.ctx.stroke();

        // Redraw background after clearing, if desired
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        this.ctx.fillRect(0, 0, width, height);

        if (!this.sampleData || this.sampleData.length === 0) return;

        this.ctx.strokeStyle = '#00ff88';
        this.ctx.beginPath();
        this.ctx.moveTo(0, middle);

        const totalSamples = this.sampleData.length;
        const visibleSamples = Math.floor(totalSamples / this.zoomLevel);
        const step = visibleSamples / width; // How many samples per pixel

        for (let i = 0; i < width; i++) {
            const sampleIndex = this.viewOffset + Math.floor(i * step);
            const amplitude = this.sampleData[sampleIndex] || 0;

            // Normalisasi nilai sampel (Int16: -32768 to 32767) ke tinggi canvas
            const y = middle - (amplitude / 32768) * middle;
            this.ctx.lineTo(i, y);
        }
        this.ctx.stroke();
    }

    zoom(direction) {
        if (direction > 0) { // Zoom in
            this.zoomLevel *= 1.5;
        } else { // Zoom out
            this.zoomLevel /= 1.5;
        }
        // Clamp zoom level
        this.zoomLevel = Math.max(1.0, this.zoomLevel);
        
        this.updateScroller();

        this.draw();
    }

    /**
     * Menambahkan event listener untuk interaksi mouse.
     */
    _addEventListeners() {
        this.canvas.addEventListener('mousedown', (e) => {
            // Prevent default text selection behavior
            e.preventDefault();
            this.isDrawing = true;
            this._editSample(e); // Langsung edit pada titik klik pertama
        });
        this.canvas.addEventListener('mousemove', (e) => {
            if (this.isDrawing) {
                this._editSample(e);
            }
        });
        this.canvas.addEventListener('mouseup', () => {
            this.isDrawing = false;
        });
        this.canvas.addEventListener('mouseleave', () => {
            this.isDrawing = false;
        });
        if (this.container) {
            const scrollbarContainer = this.container.querySelector('.fake-scrollbar-container');
            if (scrollbarContainer) {
                scrollbarContainer.addEventListener('scroll', (e) => {
                    if (!this.sampleData || this.zoomLevel <= 1.0) return;

                    const scrollLeft = e.target.scrollLeft;
                    const scrollWidth = e.target.scrollWidth - e.target.clientWidth;
                    const scrollPercentage = scrollWidth > 0 ? scrollLeft / scrollWidth : 0;
                    const totalVisibleSamples = this.sampleData.length / this.zoomLevel;
                    this.viewOffset = Math.floor(scrollPercentage * (this.sampleData.length - totalVisibleSamples));
                    this.draw();
                });
            }
        }
    }

    /**
     * Memodifikasi nilai sampel berdasarkan posisi mouse.
     * @param {MouseEvent} e - Event mouse.
     */
    _editSample(e) {
        if (!this.sampleData) return;

        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const totalVisibleSamples = this.sampleData.length / this.zoomLevel;
        const samplesPerPixel = totalVisibleSamples / this.canvas.width;

        const sampleIndex = this.viewOffset + Math.floor(x * samplesPerPixel);
        // Konversi posisi Y canvas ke nilai amplitudo Int16
        const amplitude = Math.floor(((this.canvas.height / 2) - y) / (this.canvas.height / 2) * 32767);
        
        // Batasi nilai agar tidak melebihi rentang Int16
        const clampedAmplitude = Math.max(-32768, Math.min(32767, amplitude));

        if (sampleIndex >= 0 && sampleIndex < this.sampleData.length) {
            this.sampleData[sampleIndex] = clampedAmplitude;
            
            // Gambar ulang canvas untuk menunjukkan perubahan
            this.draw();
        }
    }

    updateScroller() {
        const scroller = this.container.querySelector('.fake-scrollbar-content');
        if (scroller) {
            scroller.style.width = `${100 * this.zoomLevel}%`;
        }
    }
}

/**
 * Creates a hidden input element if it doesn't exist.
 * @param {string} id The ID of the element to find or create.
 * @returns {HTMLElement} The existing or newly created element.
 */
function ensureElement(id) {
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement('input');
        el.type = 'hidden';
        el.id = id;
        document.body.appendChild(el);
    }
    return el;
}
export class GusEditorApp {
    constructor() {
        this.ui = {
            // File controls
            btnNewPatch: document.getElementById('btn-new-patch'),
            patchUpload: document.getElementById('patch-upload'),
            btnSavePatch: document.getElementById('btn-save-patch'),
            patchFileName: document.getElementById('patch-file-name'),
            
            // Instrument properties
            instrumentName: document.getElementById('instrument-name'),
            sampleCount: document.getElementById('sample-count'),
            btnAddSample: document.getElementById('btn-add-sample'), // This might not exist in the new UI
            sampleList: document.getElementById('sample-list'),

            // Sample Editor - use ensureElement to prevent null errors
            sampleEditorPanel: document.getElementById('sample-editor-panel'),
            currentSampleName: ensureElement('current-sample-name'),
            sampleDataLength: ensureElement('sample-data-length'),
            sampleLoopStart: ensureElement('sample-loop-start'),
            sampleLoopEnd: ensureElement('sample-loop-end'),
            sampleRate: ensureElement('sample-rate'),
            samplePanning: ensureElement('sample-panning'),
            testPitch: ensureElement('test-pitch'),
            testVelocity: ensureElement('test-velocity'),
            btnNoteOn: ensureElement('btn-note-on'),
            btnNoteOff: ensureElement('btn-note-off'),
            btnExtractWav: document.getElementById('btn-extract-wav'),
            btnZoomIn: document.getElementById('btn-zoom-in'),
            btnZoomOut: document.getElementById('btn-zoom-out'),
            modeLooping: ensureElement('mode-looping'),
            modeSustain: ensureElement('mode-sustain'),
            modeEnvelope: document.getElementById('mode-envelope'),

            // Modal
            basicPropertiesModal: document.getElementById('basic-properties-modal'),
            envelopeModal: document.getElementById('envelope-modal'),
            vibratoModal: document.getElementById('vibrato-modal'),
            btnEditBasicProperties: document.getElementById('btn-edit-basic-properties'),
            btnEditEnvelope: document.getElementById('btn-edit-envelope'),
            btnEditVibrato: document.getElementById('btn-edit-vibrato'),
            btnCloseModals: document.querySelectorAll('.btn-close-modal'),

            envelopeEditor: document.querySelector('.envelope-editor'),
            // ... tambahkan elemen UI lainnya di sini saat dibutuhkan
        };

        this.waveformEditor = new WaveformEditor('waveform-canvas');
        this.instrument = null; // Objek yang menyimpan data patch
        this.samples = [];
        this.activeSampleIndex = -1;
        this.activeTestNote = null; // Menyimpan nada yang sedang aktif
        this.previewSynth = null; // Synth khusus untuk preview
        
        // Only initialize components if their corresponding UI elements exist
        if (this.ui.envelopeEditor) {
            this._createEnvelopeControls();
        }
        this._setupEventListeners();
    }

    _setupEventListeners() {
        // Safely add event listeners only if the elements exist
        if (this.ui.patchUpload) this.ui.patchUpload.addEventListener('change', (e) => this.handleFileLoad(e));
        if (this.ui.btnAddSample) this.ui.btnAddSample.addEventListener('click', () => this.addNewSample());
        if (this.ui.btnNoteOn) this.ui.btnNoteOn.addEventListener('click', () => this.playNote());
        if (this.ui.btnNoteOff) this.ui.btnNoteOff.addEventListener('click', () => this.stopNote());
        if (this.ui.btnEditBasicProperties) this.ui.btnEditBasicProperties.addEventListener('click', () => this.openModal('basic'));
        if (this.ui.btnEditEnvelope) this.ui.btnEditEnvelope.addEventListener('click', () => this.openModal('envelope'));
        if (this.ui.btnZoomIn) this.ui.btnZoomIn.addEventListener('click', () => this.waveformEditor.zoom(1));
        if (this.ui.btnZoomOut) this.ui.btnZoomOut.addEventListener('click', () => this.waveformEditor.zoom(-1));
        if (this.ui.btnEditVibrato) this.ui.btnEditVibrato.addEventListener('click', () => this.openModal('vibrato'));

        // Create and append the fake scrollbar structure
        const scrollbarContainer = document.createElement('div');
        scrollbarContainer.className = 'fake-scrollbar-container';
        scrollbarContainer.style.overflowX = 'auto';
        const scrollbarContent = document.createElement('div');
        scrollbarContent.className = 'fake-scrollbar-content';
        scrollbarContent.style.height = '1px'; // Must have some height to be scrollable
        scrollbarContainer.appendChild(scrollbarContent);
        this.waveformEditor.container.appendChild(scrollbarContainer);

        if (this.ui.btnCloseModals) {
            this.ui.btnCloseModals.forEach(btn => btn.addEventListener('click', () => this.closeAllModals()));
        }
        if (this.ui.btnExtractWav) this.ui.btnExtractWav.addEventListener('click', () => this.extractToWav());
    }

    _createEnvelopeControls() {
        this.ui.envelopePoints = [];
        for (let i = 0; i < 6; i++) {
            const pointDiv = document.createElement('div');
            pointDiv.className = 'envelope-point control-group';

            const rateLabel = document.createElement('label');
            rateLabel.textContent = `Rate ${i}`;
            const rateInput = document.createElement('input');
            rateInput.type = 'number';
            rateInput.id = `env-rate-${i}`;
            rateInput.min = 0;
            rateInput.max = 255;
            rateInput.value = 0;
            
            pointDiv.appendChild(rateLabel);
            pointDiv.appendChild(rateInput);
            this.ui.envelopeEditor.appendChild(pointDiv);
        }
    }

    async handleFileLoad(event) {
        const file = event.target.files[0];
        if (!file) return;

        this.ui.patchFileName.textContent = file.name;
        const buffer = await file.arrayBuffer();
        this.parsePatch(buffer);
    }

    addNewSample() {
        const sampleName = `Sample ${this.samples.length + 1}`;
        
        // Buat data sampel sinus dummy
        const sampleRate = 22050;
        const duration = 1.0; // 1 detik
        const length = sampleRate * duration;
        const dummyData = new Int16Array(length);
        for (let i = 0; i < length; i++) {
            dummyData[i] = Math.sin(i / sampleRate * 440 * 2 * Math.PI) * 32000;
        }

        const newSample = {
            name: sampleName,
            loop_start: 0,
            loop_end: length,
            sample_rate: sampleRate,
            panning: 64,
            data: dummyData,
            // ... properti lain akan ditambahkan di sini
        };

        this.samples.push(newSample);
        this.activeSampleIndex = this.samples.length - 1;

        this.updateSampleList();
        this.loadSampleIntoEditor(this.activeSampleIndex);
    }


    updateSampleList() {
        this.ui.sampleList.innerHTML = '';
        this.samples.forEach((sample, index) => {
            const item = document.createElement('div');
            item.className = 'sample-list-item';
            if (index === this.activeSampleIndex) {
                item.classList.add('active');
            }
            item.textContent = sample.name;
            item.addEventListener('click', () => {
                this.activeSampleIndex = index;
                this.updateSampleList();
                this.loadSampleIntoEditor(index);
            });
            this.ui.sampleList.appendChild(item);
        });
    }

    loadSampleIntoEditor(index) {
        const sample = this.samples[index];
        if (!sample) return;

        // The main editor panel is always visible now, so no need to change display style
        // if (this.ui.sampleEditorPanel) this.ui.sampleEditorPanel.style.display = 'block';
        this.ui.currentSampleName.textContent = sample.name;
        this.ui.sampleDataLength.value = sample.data.length;
        this.ui.sampleLoopStart.value = sample.loop_start;
        this.ui.sampleLoopEnd.value = sample.loop_end;
        this.ui.sampleRate.value = sample.sample_rate;
        this.ui.samplePanning.value = sample.panning || 64;
        
        this.waveformEditor.loadSample(sample.data);
    }

    // --- Parsing ---

    parsePatch(buffer) {
        const dv = new DataView(buffer);
        const u8 = new Uint8Array(buffer);
        const textDecoder = new TextDecoder('ascii');

        let offset = 0;

        // Header
        const signature = textDecoder.decode(u8.subarray(offset, offset + 11));
        if (signature !== "GF1PATCH110" && signature !== "GF1PATCH100") {
            alert("Invalid GUS Patch file signature.");
            return;
        }
        offset = 11;

        // Instrument Name
        const instNameBytes = u8.subarray(offset, offset + 60);
        const instName = textDecoder.decode(instNameBytes).split('\0')[0];
        if (this.ui.instrumentName) this.ui.instrumentName.value = instName;
        offset = 198;

        const numSamples = u8[offset++];
        this.ui.sampleCount.textContent = numSamples;
        this.samples = [];
        offset = 239;

        for (let i = 0; i < numSamples; i++) {
            if (offset >= buffer.byteLength) break;

            const sample = {};

            // Sample Name
            const waveNameBytes = u8.subarray(offset, offset + 7);
            sample.name = textDecoder.decode(waveNameBytes).split('\0')[0];
            offset += 7;

            offset++; // fractions

            const dataLengthBytes = dv.getUint32(offset, true); offset += 4;
            sample.loop_start = dv.getUint32(offset, true); offset += 4;
            sample.loop_end = dv.getUint32(offset, true); offset += 4;
            sample.sample_rate = dv.getUint16(offset, true); offset += 2;
            
            offset += 4; // low_freq
            offset += 4; // high_freq
            offset += 4; // root_freq
            offset += 2; // tune

            sample.panning = (u8[offset] * 8 + 4) & 0x7F;
            offset++;

            // Skip envelope and LFO for now
            offset += 18;

            const modes = u8[offset++];
            const is16bit = (modes & 1) !== 0;
            const isSigned = (modes & 2) === 0;

            offset += 40; // Skip scale and reserved

            // Read PCM Data
            let bytesToRead = dataLengthBytes;
            if (is16bit) {
                const numSamples = Math.floor(bytesToRead / 2);
                sample.data = new Int16Array(numSamples);
                for (let s = 0; s < numSamples; s++) {
                    sample.data[s] = isSigned ? dv.getInt16(offset, true) : dv.getUint16(offset, true) - 32768;
                    offset += 2;
                }
            } else { // 8-bit
                sample.data = new Int16Array(bytesToRead);
                for (let s = 0; s < bytesToRead; s++) {
                    const val = isSigned ? dv.getInt8(offset) : dv.getUint8(offset) - 128;
                    sample.data[s] = val * 256; // Scale to 16-bit range
                    offset++;
                }
            }
            this.samples.push(sample);
        }

        this.activeSampleIndex = 0;
        this.updateSampleList();
        this.loadSampleIntoEditor(this.activeSampleIndex);
    }

    // --- Modal Control ---

    openModal(type) {
        this.closeAllModals(); // Close any open modals first
        switch(type) {
            case 'basic':
                this.ui.basicPropertiesModal.style.display = 'flex';
                break;
            case 'envelope':
                this.ui.envelopeModal.style.display = 'flex';
                break;
            case 'vibrato':
                this.ui.vibratoModal.style.display = 'flex';
                break;
        }
    }

    closeAllModals() {
        document.querySelectorAll('.modal-overlay').forEach(modal => {
            modal.style.display = 'none';
        });
    }

    // --- Playback & Export ---

    async playNote() {
        const sample = this.samples[this.activeSampleIndex];
        // Check if the full editor UI is available. If not, this function shouldn't run.
        if (!sample || !this.ui.sampleLoopStart) {
            console.warn("playNote called without a fully initialized editor UI. Aborting.");
            return;
        }
        
        // If a note is already playing, stop it first.
        if (this.activeTestNote) {
            this.stopNote();
            await new Promise(resolve => setTimeout(resolve, 50)); // Short delay
        }

        // Use a dedicated synth instance for this test.
        if (!this.previewSynth) {
            this.previewSynth = new MidiSynth();
        }
        await this.previewSynth._ensureAudioIsRunning();

        // 1. Create a MidSample object directly from the UI data
        const midSample = new MidSample();
        midSample.data_length = sample.data.length << 12; // Fixed point
        midSample.loop_start = parseInt(this.ui.sampleLoopStart.value, 10) << 12;
        midSample.loop_end = parseInt(this.ui.sampleLoopEnd.value, 10) << 12;
        midSample.sample_rate = parseInt(this.ui.sampleRate.value, 10);
        midSample.panning = parseInt(this.ui.samplePanning.value, 10);
        midSample.root_freq = midSample.sample_rate; // Simple assumption

        let modes = MODES_16BIT;
        if (this.ui.modeLooping.checked) modes |= MODES_LOOPING;
        if (this.ui.modeSustain.checked) modes |= MODES_SUSTAIN;
        midSample.modes = modes;

        // Convert Int16 data to Float32 for the synth engine
        const floatData = new Float32Array(sample.data.length + 2); // +2 for guard samples
        for (let i = 0; i < sample.data.length; i++) {
            floatData[i] = sample.data[i] / 32768.0;
        }
        midSample.data = floatData;

        // 2. Create a MidInstrument containing just this one sample
        const midInstrument = new MidInstrument();
        midInstrument.samples = 1;
        midInstrument.sample = [midSample];

        // 3. Inject this temporary instrument into the synth's tone bank
        const program = 0;
        if (!this.previewSynth.testSoundSong.tonebank[0]) {
            this.previewSynth.testSoundSong.tonebank[0] = { instrument: new Array(128).fill(null) };
        }
        this.previewSynth.testSoundSong.tonebank[0].instrument[program] = midInstrument;

        const channel = 0;
        const pitch = parseInt(this.ui.testPitch.value, 10);
        const velocity = parseInt(this.ui.testVelocity.value, 10);
        const pan = parseInt(this.ui.samplePanning.value, 10);
        this.previewSynth.noteOn(channel, pitch, velocity, pan);
        this.activeTestNote = { channel, pitch };
    }

    stopNote() {
        if (!this.previewSynth) return;
        const channel = 0;
        const pitch = parseInt(this.ui.testPitch.value, 10);
        this.previewSynth.noteOff(channel, pitch);
        this.activeTestNote = null;
    }

    async extractToWav() {
        const sample = this.samples[this.activeSampleIndex];
        if (!sample || sample.data.length === 0) {
            alert("No sample data to extract.");
            return;
        }

        // Ensure AudioContext is running
        const tempSynth = new MidiSynth();
        await tempSynth._ensureAudioIsRunning();
        const ctx = tempSynth.ctx;
        // We need a dummy synth to get an audio context, then we can stop it.
        tempSynth.stop();

        // Create an AudioBuffer
        const audioBuffer = ctx.createBuffer(1, sample.data.length, sample.sample_rate);
        const channelData = audioBuffer.getChannelData(0);

        // Copy and convert Int16 data to Float32
        for (let i = 0; i < sample.data.length; i++) {
            channelData[i] = sample.data[i] / 32768.0;
        }

        // Use the utility function to create a WAV blob
        const wavBlob = tempSynth.audioBufferToWav(audioBuffer);
        const url = URL.createObjectURL(wavBlob);

        // Create a download link
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `${sample.name || 'sample'}.wav`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        }, 100);
    }
}

// The app is now instantiated from edit-project.php, so we remove the auto-init.
// document.addEventListener('DOMContentLoaded', () => {
//     new GusEditorApp();
// });
