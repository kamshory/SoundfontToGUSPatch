<?php
require_once __DIR__ . '/classes/Database.php';

// Get Project and Patch IDs from URL
$projectId = isset($_GET['id']) ? (int)$_GET['id'] : 0;

if ($projectId === 0) {
    header('Location: index.php');
    exit;
}

try {
    $db = Database::getInstance()->getConnection();
    $stmt = $db->prepare('SELECT name, directory_path FROM projects WHERE id = ?');
    $stmt->execute([$projectId]);
    $project = $stmt->fetch();

    if (!$project) {
        throw new Exception('Project not found.');
    }
    $projectName = htmlspecialchars($project['name'], ENT_QUOTES, 'UTF-8');

    $patchId = isset($_GET['patch_id']) ? (int)$_GET['patch_id'] : 0;
    $patchToEditName = '';
    if ($patchId > 0) {
        $patchStmt = $db->prepare('SELECT preset_name FROM patches WHERE id = ? AND project_id = ?');
        $patchStmt->execute([$patchId, $projectId]);
        $patchToEdit = $patchStmt->fetch();
        if ($patchToEdit) {
            $patchToEditName = htmlspecialchars($patchToEdit['preset_name'], ENT_QUOTES, 'UTF-8');
        }
    }

    // Fetch all patches for this project for server-side rendering
    $patchesStmt = $db->prepare('SELECT id, preset_name, program_num, patch_type FROM patches WHERE project_id = ? ORDER BY patch_type, program_num');
    $patchesStmt->execute([$projectId]);
    $allPatches = $patchesStmt->fetchAll();

} catch (Exception $e) {
    http_response_code(404);
    die('Error: ' . htmlspecialchars($e->getMessage()));
}
?><!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Editor: <?php echo $projectName; ?></title>
    <style>
        :root {
            --bg-color: #f0f2f5;
            --panel-bg: #ffffff;
            --text-color: #333;
            --text-light: #666;
            --border-color: #e0e0e0;
            --primary-color: #007bff;
            --green-color: #28a745;
            --yellow-color: #ffc107;
            --red-color: #dc3545;
            --blue-color: #17a2b8;
        }
        html, body {
            height: 100%;
            overflow: hidden; /* Prevent double scrollbars */
        }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: var(--text-color); margin: 0; padding: 0; background-color: var(--bg-color); }
        .top-bar { padding: 10px 40px; background: var(--panel-bg); border-bottom: 1px solid var(--border-color); }
        .container { background-color: var(--panel-bg); height: calc(100vh - 55px); /* Full height minus top bar */ overflow: hidden; }
        h1, h2, h3 { color: #212529; margin-bottom: 20px; }
        h1 { text-align: center; }
        a { color: var(--primary-color); text-decoration: none; }
        a:hover { text-decoration: underline; }
        .back-link { display: inline-block; margin-bottom: 25px; font-weight: 500; }
        .patch-list { list-style: none; padding: 0; }
        .patch-item { border: 1px solid var(--border-color); padding: 8px 12px; margin-bottom: 5px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; transition: box-shadow 0.2s, transform 0.2s; }
        .patch-item.active { background-color: #e0eaff; border-left: 4px solid var(--primary-color); }
        .patch-item:hover { box-shadow: 0 4px 10px rgba(0,0,0,0.05);}
        .patch-item .info { flex-grow: 1; display: flex; align-items: center; min-width: 0; /* Important for flex overflow */ }
        .patch-item .info .prog-num { font-weight: 600; color: var(--primary-color); display: inline-block; width: 40px; font-size: 0.9em; flex-shrink: 0; }
        .patch-item .info .preset-name { color: var(--text-light); font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .patch-item .actions a, .patch-item .actions button { margin-left: 5px; padding: 4px 4px; border-radius: 5px; border: none; color: #fff; cursor: pointer; font-weight: 500; transition: opacity 0.2s; display: inline-flex; align-items: center; justify-content: center; }
        .patch-item .actions button:hover { opacity: 0.85; }
        .actions .edit-btn { background-color: var(--yellow-color); color: #212529; }
        .actions .preview-btn { background-color: var(--blue-color); }
        .actions svg { width: 16px; height: 16px; }
        .main-layout { display: grid; grid-template-columns: 320px 1fr 320px; height: 100%; }
        .sidebar { background: #f8f9fa; padding: 25px; border-right: 1px solid var(--border-color); overflow-y: auto; }
        .main-content { padding: 25px; overflow-y: auto; }
        .upload-box { margin-top: 30px; padding-top: 20px; border-top: 1px solid var(--border-color); }
        .progress-wrapper { display: none; margin-top: 15px; }
        .progress-bar { width: 100%; background-color: #e9ecef; border-radius: 4px; overflow: hidden; }
        .progress-bar-fill { height: 20px; width: 0%; background-color: var(--primary-color); text-align: center; line-height: 20px; color: white; font-size: 12px; transition: width 0.2s; }
        .status-text { text-align: center; margin-top: 8px; font-weight: 500; color: #495057; }
        /* Modal Styles */
        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); display: none; justify-content: center; align-items: center; z-index: 1000; }
        .modal-content { background: var(--panel-bg); padding: 25px; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); width: 90%; max-width: 600px; }
        .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .modal-header h3 { margin: 0; }
        .modal-header .close-btn { font-size: 24px; background: none; border: none; cursor: pointer; color: var(--text-light); }
        /* Piano Keyboard Styles */
        .piano { display: flex; padding: 10px; background: #333; border-radius: 5px; }
        .key { height: 120px; border: 1px solid #000; border-radius: 0 0 5px 5px; cursor: pointer; box-shadow: inset 0 -5px 5px rgba(0,0,0,0.2); }
        .key.white { width: 40px; background: #fff; }
        .key.black { width: 24px; height: 80px; background: #222; margin-left: -12px; margin-right: -12px; z-index: 2; }
        .key.active { background: var(--blue-color); }
        .drum-pad-container { display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 10px; }
        .drum-pad { background: #444; color: white; border: 1px solid #555; border-radius: 6px; padding: 10px; text-align: center; cursor: pointer; transition: background-color 0.1s; }
        .drum-pad:hover { background: #555; }
        .drum-pad.active { background: var(--primary-color); transform: scale(0.95); }
        .drum-pad svg { width: 32px; height: 32px; }
        .drum-pad .note-name { font-size: 0.8em; margin-top: 5px; color: #ccc; }

        .preview-status { text-align: center; margin-top: 15px; height: 20px; color: var(--text-light); }
        
        /* Editor Styles (now in main content) */
        .midi-player-section {
            padding: 20px;
            border: 1px solid var(--border-color);
            border-radius: 8px;
            margin-bottom: 25px;
            background-color: #f8f9fa;
        }
        .midi-player-section .controls-section {
            margin: 15px 0;
        }
        .midi-player-section .control-btn {
            padding: 8px 15px;
        }
        .editor-sidebar { display: flex; flex-direction: column; }
        .sample-list-item { padding: 8px; border-bottom: 1px solid #eee; cursor: pointer; border-radius: 4px; }
        .sample-list-item:hover { background-color: #e9ecef; }
        .sample-list-item.active { background-color: var(--primary-color); color: white; font-weight: 500; }
        .waveform-canvas { display: block; height: 150px; background-color: #2c3e50; cursor: crosshair; }
        .control-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-top: 15px; }
        .control-group { display: flex; flex-direction: column; }
        .control-group label { margin-bottom: 5px; font-size: 0.9em; color: var(--text-light); }
        .control-group input[type="text"], .control-group input[type="number"] { padding: 8px; border: 1px solid #ccc; border-radius: 4px; width: 100%; box-sizing: border-box; }
        .editor-section { margin-top: 25px; padding-top: 20px; border-top: 1px solid var(--border-color); }
        .editor-section:first-child { margin-top: 0; padding-top: 0; border-top: none; }

        .placeholder-text { text-align: center; color: var(--text-light); margin-top: 50px; font-size: 1.2em; }

        .fake-scrollbar-container {
            height: 14px; /* Give it a visible height */
            background-color: #e9ecef; /* A background to make the track visible */
        }

        /* Always-visible scrollbar styles for Webkit browsers */
        .fake-scrollbar-container::-webkit-scrollbar {
            height: 12px;
        }
        .fake-scrollbar-container::-webkit-scrollbar-track {
            background: #e9ecef;
        }
        .fake-scrollbar-container::-webkit-scrollbar-thumb {
            background-color: #ced4da;
            border-radius: 6px;
        }

        .envelope-editor {
            display: flex;
            flex-wrap: wrap; /* Allow wrapping on smaller screens */
            gap: 15px;
        }
        .envelope-editor .control-group input[type="number"] {
            width: 60px; /* Sufficient for 3 digits */
        }

        .editor-controls {
            display: flex;
            align-items: flex-end; /* Align items to the bottom */
            gap: 20px;
            margin-bottom: 10px;
        }
        .editor-controls .control-btn,
        .editor-controls .control-group input,
        .editor-controls button {
            padding: 8px 12px;
            box-sizing: border-box;
        }

        @media (max-width: 1200px) {
            .main-layout { grid-template-columns: 1fr; }
            .sidebar { border-right: none; border-bottom: 1px solid var(--border-color); }
        }
    </style>
</head>
<body>

    <div class="top-bar">
        <a href="index.php" class="back-link">&laquo; Back to Projects</a>
        <span style="margin-left: 20px; font-weight: bold;">
            <?php echo $projectName; ?>
            <?php if ($patchId > 0): ?>
                <span style="color: var(--text-light); font-weight: normal;"> / <?php echo $patchToEditName; ?></span>
            <?php endif; ?>
        </span>
    </div>

    <div class="container">
        <div class="main-layout">
            <div class="sidebar">
                <div id="patches-container">
                    <h2>Patches</h2>
                    <div id="patch-list-tone">
                        <h3>Melodic (Bank 0)</h3>
                        <ul class="patch-list">
                            <?php
                            $toneCount = 0;
                            foreach ($allPatches as $p) {
                                if ($p['patch_type'] === 'tone') {
                                    $toneCount++;
                                    $isActive = ($p['id'] == $patchId) ? ' active' : '';
                                    echo '<li class="patch-item' . $isActive . '">';
                                    echo '<div class="info"><span class="prog-num">' . $p['program_num'] . '</span><span class="preset-name">' . htmlspecialchars($p['preset_name'], ENT_QUOTES, 'UTF-8') . '</span></div>';
                                    echo '<div class="actions">';
                                    echo '<button class="preview-btn" data-program="' . $p['program_num'] . '" data-name="' . htmlspecialchars($p['preset_name'], ENT_QUOTES, 'UTF-8') . '" data-type="tone"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8,5.14V19.14L19,12.14L8,5.14Z" /></svg></button>';
                                    echo '<a href="?id=' . $projectId . '&patch_id=' . $p['id'] . '" class="edit-btn"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z" /></svg></a>';
                                    echo '</div></li>';
                                }
                            }
                            if ($toneCount === 0) echo '<li>No melodic patches yet.</li>';
                            ?>
                        </ul>
                    </div>
                    <div id="patch-list-drum" style="margin-top: 20px;">
                        <h3>Percussion (Bank 128)</h3>
                        <ul class="patch-list">
                             <?php
                             $drumCount = 0;
                             
                             foreach ($allPatches as $p) {
                                if ($p['patch_type'] === 'drum') {
                                    $drumCount++;
                                    $isActive = ($p['id'] == $patchId) ? ' active' : '';
                                    echo '<li class="patch-item' . $isActive . '">';
                                    echo '<div class="info"><span class="prog-num">' . $p['program_num'] . '</span><span class="preset-name">' . htmlspecialchars($p['preset_name'], ENT_QUOTES, 'UTF-8') . '</span></div>';
                                    echo '<div class="actions">';
                                    echo '<button class="preview-btn" data-program="' . $p['program_num'] . '" data-name="' . htmlspecialchars($p['preset_name'], ENT_QUOTES, 'UTF-8') . '" data-type="tone"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8,5.14V19.14L19,12.14L8,5.14Z" /></svg></button>';
                                    echo '<a href="?id=' . $projectId . '&patch_id=' . $p['id'] . '" class="edit-btn"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z" /></svg></a>';
                                    echo '</div></li>';
                                }
                            }
                            if ($drumCount === 0) echo '<li>No drum patches yet.</li>';
                             ?>
                        </ul>
                    </div>
                </div>
                <div class="upload-box">
                    <h3>Add SF2 File</h3>
                    <form id="upload-form">
                        <input type="hidden" name="project_id" value="<?php echo $projectId; ?>">
                        <input type="file" name="sf2file" id="sf2file" accept=".sf2,.zip" required>
                        <button type="submit" style="width: 100%; margin-top: 10px; padding: 10px; background-color: var(--green-color); color: white; border: none; border-radius: 6px; cursor: pointer;">Upload & Convert</button>
                    </form>
                    <div class="progress-wrapper">
                        <div class="progress-bar"><div class="progress-bar-fill"></div></div>
                        <div class="status-text"></div>
                    </div>
                </div>
            </div>
            <div class="main-content">
                <div class="midi-player-section">
                    <h3>Project MIDI Player</h3>
                    <div class="upload-section">
                        <label for="midi-upload" class="upload-btn" style="padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 5px; cursor: pointer;">
                            Select MIDI File
                        </label>
                        <input type="file" id="midi-upload" accept=".mid,.midi" style="display: none;">
                        <span id="file-name" style="margin-left: 15px; color: var(--text-light);">No file selected</span>
                    </div>
                    <div class="controls-section">
                        <button id="btn-play" class="control-btn play" disabled>Play</button>
                        <button id="btn-pause" class="control-btn" disabled>Pause</button>
                        <button id="btn-stop" class="control-btn" disabled>Stop</button>
                    </div>
                    <div class="status-panel">
                        <span id="status-text" style="font-weight: 500;">Waiting for file...</span>
                        <input type="range" id="seek-slider" class="seek-slider" min="0" max="100" step="0.1" value="0" disabled style="width: 100%; margin-top: 10px;">
                    </div>
                </div>

                <?php if ($patchId > 0): ?>
                    <div id="editor-container">
                        <div class="editor-controls">
                            <div>
                                <label style="font-size: 0.9em; color: var(--text-light);">Zoom</label>
                                <div>
                                    <button id="btn-zoom-in" class="control-btn">+</button>
                                    <button id="btn-zoom-out" class="control-btn">-</button>
                                </div>
                            </div>
                            <div style="display: flex; align-items: flex-end; gap: 10px;">
                                <div class="control-group"><label for="test-pitch">Pitch</label><input type="number" id="test-pitch" min="0" max="127" value="60"></div>
                                <div class="control-group"><label for="test-velocity">Velocity</label><input type="number" id="test-velocity" min="0" max="127" value="100"></div>
                                <div class="control-group"><label>&nbsp;</label><div><button id="btn-note-on">Note On</button><button id="btn-note-off">Note Off</button></div></div>
                            </div>
                        </div>
                        <div id="waveform-container" style="border: 1px solid var(--border-color); border-bottom: none;">
                            <canvas id="waveform-canvas" class="waveform-canvas" width="1000" height="150"></canvas>
                            <div class="fake-scrollbar-container" style="overflow-x: auto;">
                                <div class="fake-scrollbar-content" style="height: 1px;"></div>
                            </div>
                        </div>
                    </div>
                <?php else: ?>
                    <p class="placeholder-text">Select a patch from the list to begin editing.</p>
                <?php endif; ?>
            </div>
            <div class="sidebar"> <!-- New sidebar for sample properties -->
                <?php if ($patchId > 0): ?>
                    <div id="sample-properties-container">
                        <div class="editor-section">
                             <h3>Samples in Patch (<span id="sample-count">0</span>)</h3>
                             <div id="sample-list" style="max-height: 200px; overflow-y: auto; margin-bottom: 10px;">
                             </div>
                        </div>
                        <h3>Sample Properties</h3>
                        <div class="editor-section">
                            <h4>Loop & Length</h4>
                            <div class="control-grid">
                                <div class="control-group"><label for="sample-data-length">Data Length</label><input type="text" id="sample-data-length" readonly></div>
                                <div class="control-group"><label for="sample-loop-start">Loop Start</label><input type="number" id="sample-loop-start"></div>
                                <div class="control-group"><label for="sample-loop-end">Loop End</label><input type="number" id="sample-loop-end"></div>
                            </div>
                        </div>
                        <div class="editor-section">
                            <h4>Basic Properties</h4>
                            <div class="control-grid">
                                <div class="control-group">
                                    <label for="sample-rate">Sample Rate</label>
                                    <input type="number" id="sample-rate" value="22050">
                                </div>
                                <div class="control-group">
                                    <label for="sample-panning">Panning (0-127)</label>
                                    <input type="number" id="sample-panning" min="0" max="127" value="64">
                                </div>
                            </div>
                            <div class="control-group" style="margin-top: 15px;">
                                <label><input type="checkbox" id="mode-looping"> Looping</label>
                                <label><input type="checkbox" id="mode-sustain"> Sustain</label>
                            </div>
                        </div>
                        <div class="editor-section">
                            <h4>Envelope</h4>
                            <div class="envelope-editor">
                                <!-- Envelope points will be generated here by JS -->
                            </div>
                        </div>
                        <div class="editor-section">
                            <h4>Vibrato & Tremolo</h4>
                            <div class="control-grid">
                                <div class="control-group">
                                    <label for="vib-sweep">Vibrato Sweep</label><input type="number" id="vib-sweep" min="0" max="255" value="0">
                                    <label for="vib-rate">Vibrato Rate</label><input type="number" id="vib-rate" min="0" max="255" value="0">
                                    <label for="vib-depth">Vibrato Depth</label><input type="number" id="vib-depth" min="0" max="255" value="0">
                                </div>
                                <div class="control-group">
                                    <label for="trem-sweep">Tremolo Sweep</label><input type="number" id="trem-sweep" min="0" max="255" value="0">
                                    <label for="trem-rate">Tremolo Rate</label><input type="number" id="trem-rate" min="0" max="255" value="0">
                                    <label for="trem-depth">Tremolo Depth</label><input type="number" id="trem-depth" min="0" max="255" value="0">
                                </div>
                            </div>
                        </div>
                    </div>
                <?php else: ?>
                    <p class="placeholder-text">Select a patch from the list to begin editing.</p>
                <?php endif; ?>
            </div>
        </div>
    </div>

    <!-- Preview Modal (still useful) -->
    <div id="preview-modal" class="modal-overlay">
        <div class="modal-content">
            <div class="modal-header">
                <h3 id="preview-title">Preview Patch</h3>
                <button class="close-btn">&times;</button>
            </div>
            <div class="piano-container" style="overflow-x: auto;">
                <div class="piano"></div>
            </div>
            <div class="drum-pad-container" style="display: none;">
                <!-- Drum pads will be generated here -->
            </div>
            <div class="preview-status">Loading audio engine...</div>
        </div>
    </div>

    <script type="module">
        import { MidiSynth } from './assets/js/audio.js';
        import { GusEditorApp } from './assets/js/gus-editor-app.js';
        import { PlanetMidi } from './assets/js/app.js';
        import { DRUM_ICON_SET, DRUM_NOTE_MAP } from './assets/js/midi-icons.js';

        document.addEventListener('DOMContentLoaded', function() {
            const projectId = <?php echo $projectId; ?>;
            const patchIdToEdit = <?php echo $patchId; ?>;
            const projectDir = 'projects/<?php echo $project['directory_path']; ?>';
            const toneList = document.querySelector('#patch-list-tone ul');
            const drumList = document.querySelector('#patch-list-drum ul');
            const uploadForm = document.getElementById('upload-form');
            const previewModal = document.getElementById('preview-modal');
            const pianoContainer = previewModal.querySelector('.piano');
            const drumPadContainer = previewModal.querySelector('.drum-pad-container');
            const previewStatus = previewModal.querySelector('.preview-status');
            const previewTitle = previewModal.querySelector('#preview-title');

            // Initialize MIDI Player for the project
            const midiPlayer = new PlanetMidi({
                uploadInputId: 'midi-upload',
                fileNameDisplayId: 'file-name',
                btnPlayId: 'btn-play',
                btnPauseId: 'btn-pause',
                btnStopId: 'btn-stop',
                statusTextId: 'status-text',
                infoPanelId: 'info-panel', // This element doesn't exist here, but that's okay
                seekSliderId: 'seek-slider',
                sampleRate: 44100,
                bufferSize: 8192,
                timidityCfg: 'timidity.cfg',
                patchUrlBase: `./${projectDir}/`,
            });

            let editorApp; // Instance of GusEditorApp
            let instrumentPreviewSynth;
            let isSynthReady = false;

            function handleUpload() {
                const submitButton = uploadForm.querySelector('button');
                const progressWrapper = document.querySelector('.progress-wrapper');
                const progressBarFill = document.querySelector('.progress-bar-fill');
                const statusText = document.querySelector('.status-text');

                uploadForm.addEventListener('submit', function(e) {
                    e.preventDefault();
                    const fileInput = document.getElementById('sf2file');
                    if (fileInput.files.length === 0) return;

                    submitButton.disabled = true;
                    progressWrapper.style.display = 'block';

                    const formData = new FormData(uploadForm);
                    const xhr = new XMLHttpRequest();
                    
                    const file = fileInput.files[0];
                    const extension = file.name.split('.').pop().toLowerCase();
                    // Use the correct action based on file type, although backend now auto-detects
                    const action = (extension === 'zip' || extension === 'pat') ? 'upload_pat' : 'upload_sf2';

                    xhr.open('POST', `api/editor.php?action=${action}`, true);

                    xhr.upload.addEventListener('progress', function(e) {
                        if (e.lengthComputable) {
                            const percentComplete = Math.round((e.loaded / e.total) * 100);
                            progressBarFill.style.width = percentComplete + '%';
                            progressBarFill.textContent = percentComplete + '%';
                            if (percentComplete === 100) {
                                statusText.textContent = 'Processing file on server...';
                            } else {
                                statusText.textContent = 'Uploading...';
                            }
                        }
                    });

                    xhr.onload = function() {
                        let message = 'An unknown error occurred.';
                        let isSuccess = false;
                        if (xhr.status === 200) {
                            try {
                                const result = JSON.parse(xhr.responseText);
                                if (result.success) {
                                    message = 'Upload and conversion successful!';
                                    isSuccess = true;
                                    // Reload the page to show the new patches rendered by the server
                                    window.location.reload();
                                } else {
                                    message = 'Error: ' + (result.error || 'Conversion failed.');
                                }
                            } catch (err) {
                                message = 'Error parsing server response.';
                            }
                        } else {
                            message = `Server returned status ${xhr.status}`;
                        }

                        statusText.textContent = message;
                        progressBarFill.style.backgroundColor = isSuccess ? 'var(--green-color)' : 'var(--red-color)';

                        setTimeout(() => {
                            submitButton.disabled = false;
                            progressWrapper.style.display = 'none';
                            progressBarFill.style.width = '0%';
                            progressBarFill.textContent = '';
                            progressBarFill.style.backgroundColor = '#007bff';
                            statusText.textContent = '';
                            uploadForm.reset();
                        }, 4000);
                    };

                    xhr.onerror = function() {
                        statusText.textContent = 'A network error occurred.';
                        submitButton.disabled = false;
                    };

                    xhr.send(formData);
                });
            }

            function escapeHtml(unsafe) {
                if (!unsafe) return '';
                return unsafe.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
            }

            // --- Preview Functionality ---

            async function initSynth() {
                if (instrumentPreviewSynth) return;
                instrumentPreviewSynth = new MidiSynth({
                    patchUrlBase: `./${projectDir}/`, // e.g., './projects/MyProject_123/'
                    timidityCfg: `timidity.cfg`      // Just the filename
                });
                try {
                    await instrumentPreviewSynth._initForLivePlayback();
                    isSynthReady = true;
                    previewStatus.textContent = 'Ready to play.';
                } catch (e) {
                    console.error("Synth init failed:", e);
                    previewStatus.textContent = 'Error: Could not load instruments config.';
                }
            }

            function createPiano() {
                const keys = [
                    { note: 60, type: 'white' }, { note: 61, type: 'black' }, { note: 62, type: 'white' },
                    { note: 63, type: 'black' }, { note: 64, type: 'white' }, { note: 65, type: 'white' },
                    { note: 66, type: 'black' }, { note: 67, type: 'white' }, { note: 68, type: 'black' },
                    { note: 69, type: 'white' }, { note: 70, type: 'black' }, { note: 71, type: 'white' },
                    { note: 72, type: 'white' }
                ];
                pianoContainer.innerHTML = '';
                keys.forEach(({ note, type }) => {
                    const key = document.createElement('div');
                    key.className = `key ${type}`;
                    key.dataset.note = note;
                    pianoContainer.appendChild(key);
                });
            }

            function createDrumPads() {
                drumPadContainer.innerHTML = '';
                for (const note in DRUM_NOTE_MAP) {
                    const pad = document.createElement('div');
                    pad.className = 'drum-pad';
                    pad.dataset.note = note;
                    
                    const icon = DRUM_NOTE_MAP[note].icon || DRUM_ICON_SET.kick;
                    const name = DRUM_NOTE_MAP[note].name;

                    pad.innerHTML = `
                        ${icon}
                        <div class="note-name">${name} (${note})</div>
                    `;
                    drumPadContainer.appendChild(pad);
                }
            }

            async function openPreviewModal(program, name, type) {
                previewTitle.textContent = `Preview: #${program} ${name}`;
                previewModal.style.display = 'flex';
                previewStatus.textContent = 'Loading audio engine...';
                await initSynth();
                if (!isSynthReady) return;

                const channel = (type === 'drum') ? 9 : 0;

                if (type === 'drum') {
                    pianoContainer.style.display = 'none';
                    drumPadContainer.style.display = 'grid';
                } else {
                    pianoContainer.style.display = 'flex';
                    drumPadContainer.style.display = 'none';
                }

                previewStatus.textContent = `Loading instrument #${program}...`;
                await instrumentPreviewSynth.programChange(channel, program);
                previewStatus.textContent = 'Ready to play.';

                const playHandler = (e) => {
                    if (e.target.classList.contains('key')) {
                        const note = parseInt(e.target.dataset.note, 10);
                        instrumentPreviewSynth.noteOn(channel, note, 100); // Velocity 100
                        e.target.classList.add('active');
                        const releaseHandler = () => {
                            instrumentPreviewSynth.noteOff(channel, note);
                            e.target.classList.remove('active');
                            pianoContainer.removeEventListener('mouseup', releaseHandler);
                            pianoContainer.removeEventListener('mouseleave', releaseHandler);
                        };
                        pianoContainer.addEventListener('mouseup', releaseHandler);
                        pianoContainer.addEventListener('mouseleave', releaseHandler);
                    } else if (e.target.closest('.drum-pad')) {
                        const pad = e.target.closest('.drum-pad');
                        const note = parseInt(pad.dataset.note, 10);
                        instrumentPreviewSynth.noteOn(channel, note, 100); // Velocity 100
                        pad.classList.add('active');
                        setTimeout(() => pad.classList.remove('active'), 150);
                    }
                };

                pianoContainer.onmousedown = playHandler;
                drumPadContainer.onmousedown = playHandler;
            }

            // --- Editor Initialization ---
            async function initEditor(patchId) {
                if (!patchId) return;

                // Ensure the editor container exists before initializing
                if (document.getElementById('editor-container')) {
                    // Initialize the dedicated synth for the sample editor
                    const sampleEditorSynth = new MidiSynth();
                    editorApp = new GusEditorApp(sampleEditorSynth);
                    try {
                    const response = await fetch(`api/editor.php?action=get_patch_data&patch_id=${patchId}`);
                    if (!response.ok) throw new Error(`Server responded with ${response.status}`);
                    const buffer = await response.arrayBuffer();
                    // Assuming parsePatch will populate the UI elements that are now on the main page
                    editorApp.parsePatch(buffer); 
                } catch (error) {
                    console.error("Failed to load patch data for editor:", error);
                    document.querySelector('.main-content').innerHTML = '<p class="placeholder-text">Error: Could not load patch data.</p>';
                }
            }
            }

            // Initial setup
            handleUpload();
            createPiano();
            createDrumPads();
            initEditor(patchIdToEdit);

            // Main Event Listeners
            document.querySelector('.sidebar').addEventListener('click', function(e) {
                const previewBtn = e.target.closest('.preview-btn');
                const editBtn = e.target.closest('.edit-btn');

                if (previewBtn) {
                    e.preventDefault(); // Prevent navigation if it's inside an <a>
                    const { program, name, type } = previewBtn.dataset;
                    openPreviewModal(parseInt(program, 10), name, type);
                }
            });

            previewModal.querySelector('.close-btn').addEventListener('click', () => {
                previewModal.style.display = 'none';
                // Stop any hanging notes if the modal is closed
                if (instrumentPreviewSynth) for (let i=0; i<128; i++) instrumentPreviewSynth.noteOff(0, i), instrumentPreviewSynth.noteOff(9, i);
            });
        });
    </script>

</body>
</html>