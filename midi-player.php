<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Timidity Web Player</title>
  <meta name="description" content="A pure JavaScript Web MIDI Player based on libtimidity.">
  <link rel="stylesheet" href="style.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
</head>
<body>
  <div class="background-anim"></div>
  
  <div class="container glass-panel">
    <header>
      <h1>Timidity Web Synth</h1>
      <p>Pure JavaScript MIDI Player</p>
    </header>
    
    <main>
      <div class="upload-section">
        <label for="midi-upload" class="upload-btn">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
          Select MIDI File
        </label>
        <input type="file" id="midi-upload" accept=".mid,.midi">
        <button id="btn-test" class="control-btn" style="margin-left: 10px; padding: 10px;">Load Test MIDI</button>
        <div id="file-name" class="file-name">No file selected</div>
      </div>
      
      <div class="controls-section">
        <button id="btn-play" class="control-btn play" disabled>Play</button>
        <button id="btn-pause" class="control-btn" disabled>Pause</button>
        <button id="btn-stop" class="control-btn" disabled>Stop</button>
      </div>

      <div class="status-panel">
        <h3>Status: <span id="status-text">Waiting for file...</span></h3>
        <div class="progress-bar">
        <input type="range" id="seek-slider" class="seek-slider" min="0" max="100" step="0.1" value="0" disabled>
      </div>
      </div>
      
      <div class="preview-section glass-panel">
        <h3>Sound Preview</h3>
        <div class="preview-controls">
          <div class="control-group">
            <label for="preview-channel">Channel</label>
            <select id="preview-channel"></select>
          </div>
          <div class="control-group">
            <label for="preview-instrument">Instrument</label>
            <select id="preview-instrument"></select>
          </div>
          <div class="control-group">
            <label for="preview-pitch">Pitch</label>
            <input type="number" id="preview-pitch" min="0" max="127" value="60">
          </div>
          <div class="control-group">
            <label for="preview-velocity">Velocity</label>
            <input type="number" id="preview-velocity" min="0" max="127" value="100">
          </div>
          <div class="control-group">
            <label for="preview-pan">Pan (0-127)</label>
            <input type="number" id="preview-pan" min="0" max="127" value="64">
          </div>
          <button id="btn-noteon" class="control-btn">Note On</button>
          <button id="btn-noteoff" class="control-btn">Note Off</button>
          <div class="control-group ducking-control">
            <label>
              <input type="checkbox" id="chk-duck-volume" checked>
              Turunkan volume lagu saat test
            </label>
          </div>
        </div>
      </div>

      <div class="info-panel" id="info-panel">
        <!-- MIDI info will appear here -->
      </div>

      <!-- Track selector is created dynamically here -->

      <div id="render-options-panel" class="glass-panel" style="display: none;">
        <h3>Render Options</h3>
        <label style="display: block;">
          <input type="checkbox" id="render-spatial3d"> Spatial 3D Audio
        </label>
        <label style="display: block;">
          <input type="checkbox" id="render-mono"> Mono Audio
        </label>
      </div>
    </main>
  </div>
  
  <script type="module" src="assets/js/midi-player.js"></script>
</body>
</html>
