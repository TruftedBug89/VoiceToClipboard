const { ipcRenderer } = require('electron');

const micBtn = document.getElementById('mic-button');
const subtitlesContainer = document.getElementById('subtitles-container');
const subtitles = document.getElementById('subtitles');
const closeBtn = document.getElementById('close-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const apiKeyInput = document.getElementById('api-key-input');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const canvas = document.getElementById('visualizer-canvas');
const canvasCtx = canvas.getContext('2d');

let isRecording = false;
let mediaRecorder;
let audioChunks = [];
let recognition;
let finalSubtitleText = "";

// Web Audio API Visualizer & Sound Feedback Context
let audioCtx;
let analyser;
let source;
let animationFrameId;

// Synthesize short audio cues
function playBeep(freq = 880, duration = 0.08) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + duration);
    } catch (e) {}
}

// Draw circular audio waveform visualizer
function drawVisualizer() {
    if (!analyser || !isRecording) {
        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
        return;
    }

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const baseRadius = 32;

    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = 'rgba(230, 57, 70, 0.8)';
    canvasCtx.beginPath();

    const bars = 32;
    const step = (Math.PI * 2) / bars;

    for (let i = 0; i < bars; i++) {
        const value = dataArray[i * 2] || 0;
        const barHeight = (value / 255) * 12;
        const angle = i * step;

        const x1 = centerX + Math.cos(angle) * baseRadius;
        const y1 = centerY + Math.sin(angle) * baseRadius;
        const x2 = centerX + Math.cos(angle) * (baseRadius + barHeight);
        const y2 = centerY + Math.sin(angle) * (baseRadius + barHeight);

        canvasCtx.moveTo(x1, y1);
        canvasCtx.lineTo(x2, y2);
    }

    canvasCtx.stroke();
    animationFrameId = requestAnimationFrame(drawVisualizer);
}

// Setup Speech Recognition
if ('webkitSpeechRecognition' in window) {
    recognition = new webkitSpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
        finalSubtitleText = "";
    };

    recognition.onresult = (event) => {
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalSubtitleText += event.results[i][0].transcript + " ";
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }
        const display = finalSubtitleText + interimTranscript;
        if (display.trim()) {
            subtitlesContainer.classList.add('visible');
            subtitles.innerText = display;
        }
    };

    recognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
    };
}

// Global Hotkey / IPC toggle handler
ipcRenderer.on('toggle-recording', () => {
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
});

ipcRenderer.on('open-settings', () => {
    openSettings();
});

// App Settings & Keys
async function checkApiKeyStatus() {
    const status = await ipcRenderer.invoke('get-api-key-status');
    if (!status.hasKey) {
        subtitlesContainer.classList.add('visible');
        subtitles.innerHTML = `⚠️ <span style="color:#ffb703">GEMINI_API_KEY missing!</span> Click ⚙️ to set it.`;
    }
}

function openSettings() {
    ipcRenderer.invoke('get-api-key-status').then(status => {
        apiKeyInput.value = status.key || '';
        settingsModal.classList.add('active');
    });
}

function closeSettings() {
    settingsModal.classList.remove('active');
}

saveSettingsBtn.addEventListener('click', async () => {
    const val = apiKeyInput.value.trim();
    if (val) {
        const res = await ipcRenderer.invoke('save-api-key', val);
        if (res.success) {
            subtitlesContainer.classList.add('visible');
            subtitles.innerText = "✅ API Key saved successfully!";
            closeSettings();
            setTimeout(() => checkApiKeyStatus(), 2000);
        }
    }
});

settingsBtn.addEventListener('click', openSettings);
closeModalBtn.addEventListener('click', closeSettings);
closeBtn.addEventListener('click', () => window.close());

micBtn.addEventListener('click', () => {
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
});

async function startRecording() {
    try {
        const status = await ipcRenderer.invoke('get-api-key-status');
        if (!status.hasKey) {
            openSettings();
            return;
        }

        playBeep(880, 0.08); // High beep

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Setup Visualizer Node
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);

        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        audioChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
            playBeep(523, 0.1); // Lower finish beep

            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            subtitlesContainer.classList.add('visible');
            subtitles.innerText = "✨ Transcribing with Gemini AI...";
            micBtn.classList.remove('recording');

            try {
                const arrayBuffer = await audioBlob.arrayBuffer();
                const result = await ipcRenderer.invoke('transcribe-audio', arrayBuffer);

                if (result.success) {
                    subtitles.innerText = `📋 Copied: "${result.text}"`;
                    setTimeout(() => {
                        if (!isRecording) subtitlesContainer.classList.remove('visible');
                    }, 5000);
                } else {
                    subtitles.innerText = `❌ Error: ${result.error}`;
                }
            } catch (err) {
                subtitles.innerText = "❌ IPC Error: " + err.message;
            }

            // Cleanup stream & Audio Context
            stream.getTracks().forEach(track => track.stop());
            if (audioCtx) {
                audioCtx.close();
                audioCtx = null;
            }
        };

        mediaRecorder.start();
        isRecording = true;
        micBtn.classList.add('recording');

        subtitlesContainer.classList.add('visible');
        subtitles.innerText = "Listening...";
        finalSubtitleText = "";

        if (recognition) recognition.start();
        drawVisualizer();

    } catch (err) {
        console.error("Microphone error:", err);
        subtitlesContainer.classList.add('visible');
        subtitles.innerText = "❌ Microphone access denied or unavailable.";
        setTimeout(() => subtitlesContainer.classList.remove('visible'), 3000);
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    if (recognition) recognition.stop();
    isRecording = false;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
}

// Initial check on load
checkApiKeyStatus();
