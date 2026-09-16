/**
 * MIDIPlayer Polyfill for libtimidity-player
 * This script provides a compatible `MIDIPlayer` object that wraps `TimidityPlayer`.
 * It is used to avoid rewriting all the legacy logic in script.js, vocal-training.js, etc.
 */

(function() {
    if (typeof window.MIDIPlayer !== 'undefined') return;

    let player = null;
    let initialized = false;
    let playingTimer = null;

    function ensurePlayer() {
        if (!player) {
            if (typeof timidityPlayer !== 'undefined' && timidityPlayer) {
                player = timidityPlayer;
            } else if (typeof window.timidityPlayer !== 'undefined' && window.timidityPlayer) {
                player = window.timidityPlayer;
            } else {
                let patchUrlBase = 'gus-patch'; // Default for the local player
                if (typeof window !== 'undefined' && window.location.pathname.includes('/composer')) {
                    patchUrlBase = 'assets/libtimidity-player/gus-patch';
                }
                player = new TimidityPlayer({ patchUrlBase: patchUrlBase });
                window.timidityPlayer = player; // Also expose it globally for scripts that look for it
            }
            
            player.on('onInstrumentLoading', (loadedCount, totalCount) => {
                if (window.MIDIPlayer._loadMidiCallback) {
                    window.MIDIPlayer._loadMidiCallback(totalCount, loadedCount);
                }
            });
            player.on('onPlaying', (tick, timeInSeconds) => {
                window.MIDIPlayer.currentTime = timeInSeconds;
                if (window.MIDIPlayer.onPlaying) {
                    window.MIDIPlayer.onPlaying(tick, timeInSeconds);
                }
            });
            player.on('onEnded', () => {
                if (playingTimer) { clearInterval(playingTimer); playingTimer = null; }
                if (window.MIDIPlayer.onEnded) window.MIDIPlayer.onEnded();
            });
            player.on('error', (err) => {
                if (window.MIDIPlayer.initError) window.MIDIPlayer.initError(err);
            });
        }
    }

    function startCallbackInterval() {
        if (playingTimer) clearInterval(playingTimer);
        playingTimer = setInterval(() => {
            if (window.MIDIPlayer.playerCallback) {
                let isPlaying = player.isPlaying || false;
                window.MIDIPlayer.playerCallback({ time: window.MIDIPlayer.currentTime, isPlaying: isPlaying });
            }
        }, 50);
    }

    function stopCallbackInterval() {
        if (playingTimer) { clearInterval(playingTimer); playingTimer = null; }
    }

    window.MIDIPlayer = {
        currentTime: 0,
        _loadMidiCallback: null,
        onEnded: null,
        onPlaying: null,
        playerCallback: null,
        initError: null,

        loadMidi: function(base64Str, offset, callback, startPlaying = true) {
            ensurePlayer();
            
            // Synchronously create/resume audio context to avoid autoplay restrictions
            if (!player.audioContext) {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                player.audioContext = new AudioContextClass({ sampleRate: 44100 });
            }
            if (player.audioContext.state === 'suspended') {
                player.audioContext.resume().catch(() => {}); // Attempt to resume immediately
            }

            this._loadMidiCallback = callback;
            let initPromise = initialized ? Promise.resolve() : player.init().then(() => { initialized = true; });
            
            initPromise.then(() => {
                let base64 = base64Str;
                if (base64.indexOf(',') !== -1) {
                    base64 = base64.split(',')[1];
                }
                const binaryStr = window.atob(base64);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    bytes[i] = binaryStr.charCodeAt(i);
                }

                player.load(bytes).then(() => {
                    if (callback) callback(100, 100);
                    if (startPlaying) {
                        this.play(null, offset);
                    }
                }).catch(err => {
                    if (this.initError) this.initError(err);
                });
            });
        },
        play: function(base64Str, offset) {
            ensurePlayer();
            if (base64Str) {
                this.loadMidi(base64Str, offset, null, true);
            } else {
                player.play(offset);
                startCallbackInterval();
            }
        },
        stop: function() {
            if (player) player.stop();
            stopCallbackInterval();
        },
        pause: function() {
            if (player) player.pause();
            stopCallbackInterval();
        },
        setVolume: function(vol) {
            ensurePlayer();
            player.setVolume(vol * 100);
        },
        getAudioContext: function() {
            ensurePlayer();
            return player.audioContext;
        }
    };
})();
