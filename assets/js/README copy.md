# Planet MIDI Player

This is a comprehensive JavaScript MIDI player for web browsers, built upon LibTiMidity 0.2.7 (a port of the TiMidity++ synthesizer). It provides a high-level API for loading and playing MIDI files, along with a user interface controller for common playback functions.

## Features

*   **MIDI Playback**: Plays MIDI files from a local file upload or a specified URL.
*   **Playback Controls**: Standard controls including Play, Pause, Resume, Stop, and a seek slider.
*   **Volume Control**: Adjust the master volume.
*   **Instrument Loading**: Dynamically loads required instrument patches and displays loading progress.
*   **Offline Rendering**: Renders the full MIDI file to a WAV audio file for download.
*   **Status Display**: Shows real-time status like "Loading", "Playing", "Paused", and MIDI file information.
*   **Easy Integration**: Designed to connect easily with a predefined HTML structure.

## Getting Started

To use the Planet MIDI Player, you need to include the main script in your HTML file and provide the necessary HTML elements for the player's UI.

### 1. HTML Structure

Create the following HTML elements with the specified IDs. The player will automatically bind its functionality to them.

### 2. JavaScript Integration

Include the `app.js` script as a module in your HTML file. The script will automatically initialize the player once the DOM is loaded.

## Configuration

The `PlanetMidi` class is initialized with an options object. The primary options are the IDs of the UI elements. You can also pass advanced options to the underlying `MidiSynth` engine.

*   `uploadInputId`: ID of the file input element.
*   `fileNameDisplayId`: ID of the element to display the current file name.
*   `btnPlayId`: ID of the play/pause/resume button.
*   `btnPauseId`: ID of the pause button.
*   `btnStopId`: ID of the stop button.
*   `statusTextId`: ID of the element to display status messages.
*   `infoPanelId`: ID of the container for MIDI file information.
*   `seekSliderId`: ID of the playback seek slider.
*   `btnTestId`: ID of the button to load a test MIDI file.

### Advanced `MidiSynth` Options

*   `audioContext`: An existing `AudioContext` instance. If not provided, one will be created.
*   `patchUrlBase`: The base URL from which to load instrument patch files (`.pat`).
*   `sampleRate`: The desired sample rate for the audio context.
*   `bufferSize`: The audio buffer size.

## Public API

The `PlanetMidi` class exposes several public methods for programmatic control:

*   `async load(midiSource, name)`: Loads a MIDI file. `midiSource` can be a File object or a URL string.
*   `async play()`: Starts or resumes playback.
*   `pause()`: Pauses playback.
*   `resume()`: Resumes paused playback.
*   `stop()`: Stops playback and resets the position.
*   `seek(timeInSeconds)`: Seeks to a specific time in the song.
*   `setVolume(volume)`: Sets the master volume (0.0 to 1.0).
*   `async renderOffline()`: Renders the loaded MIDI to a WAV file and initiates a download.

### Live Sound API (via `synth` property)

For real-time sound generation, such as in a MIDI editor, you can access the underlying `MidiSynth` instance via the `synth` property.

*   `async synth.programChange(channel, program)`: Changes the instrument for a specific channel. This will load the instrument if it's not already available.
*   `async synth.noteOn(channel, note, velocity)`: Plays a single note. The engine will automatically initialize for live playback if needed.
*   `synth.noteOff(channel, note)`: Stops a single note.

Example:
```javascript
myPlanetMidi.synth.noteOn(0, 60, 100); // Play note C4 on channel 0
setTimeout(() => myPlanetMidi.synth.noteOff(0, 60), 500);
```
