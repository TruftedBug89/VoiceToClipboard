const { ipcRenderer } = require('electron');

const micBtn = document.getElementById('mic-button');
const closeBtn = document.getElementById('close-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const apiKeyInput = document.getElementById('api-key-input');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const apiKeyNote = document.getElementById('api-key-note');
const removeKeyBtn = document.getElementById('remove-key-btn');
const canvas = document.getElementById('visualizer-canvas');
const canvasCtx = canvas.getContext('2d');
const micContainer = document.getElementById('mic-container');
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');

let isRecording = false;
let mediaRecorder;
let audioChunks = [];
let cancelPending = false;

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

// Minimal status indicator (dot + text)
function setStatus(mode, text) {
    statusText.textContent = text;
    statusBadge.classList.remove('busy', 'done', 'dim', 'err');
    if (mode) statusBadge.classList.add(mode);
    statusBadge.classList.add('visible');
}

function hideStatus() {
    statusBadge.classList.remove('visible');
}

// ---- Custom drag & click logic (hold+drag moves the window, quick press toggles record/cancel) ----
const DRAG_THRESHOLD = 3;
let pointerDrag = null;

document.addEventListener('pointerdown', (e) => {
    if (settingsModal.classList.contains('active')) return;
    if (micContainer.contains(e.target)) {
        pointerDrag = { pid: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
        try { micContainer.setPointerCapture(e.pointerId); } catch (err) {}
        ipcRenderer.send('drag-start');
    }
});

document.addEventListener('pointermove', (e) => {
    if (!pointerDrag || e.pointerId !== pointerDrag.pid) return;
    if (!pointerDrag.moved &&
        Math.abs(e.clientX - pointerDrag.startX) + Math.abs(e.clientY - pointerDrag.startY) > DRAG_THRESHOLD) {
        pointerDrag.moved = true;
        micContainer.classList.add('dragging');
    }
    if (pointerDrag.moved) {
        ipcRenderer.send('drag-move');
    }
});

function endPointerDrag() {
    if (pointerDrag) {
        pointerDrag = null;
        micContainer.classList.remove('dragging');
        ipcRenderer.send('drag-end');
    }
}

document.addEventListener('pointerup', (e) => {
    if (!pointerDrag || e.pointerId !== pointerDrag.pid) return;
    const wasDrag = pointerDrag.moved;
    endPointerDrag();
    if (!wasDrag && micContainer.contains(e.target) && !settingsModal.classList.contains('active')) {
        if (!isRecording) {
            startRecording();
        } else {
            stopRecording(); // click during recording = submit & transcribe
        }
    }
});

document.addEventListener('pointercancel', (e) => {
    if (pointerDrag && e.pointerId === pointerDrag.pid) {
        endPointerDrag();
    }
});

// Esc cancels an active recording
document.addEventListener('keydown', (e) => {
    if (isRecording && e.key === 'Escape') {
        cancelRecording();
    }
});

// ---- Click-through transparent areas (only interactive spots capture the mouse) ----
let mouseIgnored = true;
let mouseX = 0, mouseY = 0;

function refreshMouseIgnore() {
    if (pointerDrag) return; // never re-ignore mid-drag
    const el = document.elementFromPoint(mouseX, mouseY);
    const interactive = !!(el && (
        el.closest('#mic-container') ||
        el.closest('#top-bar') ||
        el.closest('#settings-modal')
    ));
    const shouldIgnore = !interactive;
    if (shouldIgnore !== mouseIgnored) {
        mouseIgnored = shouldIgnore;
        ipcRenderer.send('set-ignore-mouse', mouseIgnored);
    }
}

document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    refreshMouseIgnore();
});

// Global Hotkey / IPC handlers
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

// ---- App Settings ----
async function checkApiKeyStatus() {
    const status = await ipcRenderer.invoke('get-api-key-status');
    if (!status.hasKey) {
        setStatus('err', 'API KEY REQUIRED');
    }
}

function openSettings() {
    hideStatus();
    mouseIgnored = false;
    ipcRenderer.send('set-ignore-mouse', false);
    ipcRenderer.send('set-settings-open', true);
    settingsModal.classList.add('active');
    refreshSettingsUi();
}

async function refreshSettingsUi() {
    const status = await ipcRenderer.invoke('get-api-key-status');
    apiKeyInput.value = '';
    removeKeyBtn.style.display = status.source === 'config' ? 'inline-block' : 'none';
    if (status.source === 'env') {
        apiKeyNote.innerHTML = 'Key comes from the <code>GEMINI_API_KEY</code> environment variable.';
    } else if (status.source === 'config') {
        apiKeyNote.textContent = '✓ Key saved in this app.';
    } else {
        apiKeyNote.innerHTML = 'No key yet — get a free one at <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>.';
    }
}

function closeSettings() {
    settingsModal.classList.remove('active');
    ipcRenderer.send('set-settings-open', false);
    refreshMouseIgnore();
}

saveSettingsBtn.addEventListener('click', async () => {
    const val = apiKeyInput.value.trim();
    if (!val) { closeSettings(); return; }
    const res = await ipcRenderer.invoke('save-api-key', val);
    if (res.success) {
        setStatus('done', 'KEY SAVED');
        setTimeout(hideStatus, 1600);
        closeSettings();
        setTimeout(() => checkApiKeyStatus(), 2000);
    }
});

removeKeyBtn.addEventListener('click', async () => {
    await ipcRenderer.invoke('remove-api-key');
    refreshSettingsUi();
});

settingsBtn.addEventListener('click', openSettings);
closeModalBtn.addEventListener('click', closeSettings);
closeBtn.addEventListener('click', () => window.close());

// Draw circular audio waveform visualizer
const smoothValues = new Array(32).fill(0);

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
    const baseRadius = 31;

    const bars = 32;
    const step = (Math.PI * 2) / bars;

    canvasCtx.lineWidth = 2.4;
    canvasCtx.lineCap = 'round';
    canvasCtx.shadowColor = 'rgba(230, 57, 70, 0.9)';
    canvasCtx.shadowBlur = 7;

    for (let i = 0; i < bars; i++) {
        const target = dataArray[i * 2] || 0;
        smoothValues[i] += (target - smoothValues[i]) * 0.3;
        const barHeight = (smoothValues[i] / 255) * 14;

        const angle = i * step;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const x1 = centerX + cos * baseRadius;
        const y1 = centerY + sin * baseRadius;
        const x2 = centerX + cos * (baseRadius + barHeight);
        const y2 = centerY + sin * (baseRadius + barHeight);

        canvasCtx.strokeStyle = `rgba(255, ${Math.round(90 + barHeight * 4)}, ${Math.round(90 + barHeight * 3)}, 0.9)`;
        canvasCtx.beginPath();
        canvasCtx.moveTo(x1, y1);
        canvasCtx.lineTo(x2, y2);
        canvasCtx.stroke();
    }

    canvasCtx.shadowBlur = 0;

    canvasCtx.strokeStyle = 'rgba(230, 57, 70, 0.25)';
    canvasCtx.lineWidth = 1;
    canvasCtx.beginPath();
    canvasCtx.arc(centerX, centerY, baseRadius + 1, 0, Math.PI * 2);
    canvasCtx.stroke();

    animationFrameId = requestAnimationFrame(drawVisualizer);
}

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
        cancelPending = false;

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
            playBeep(523, 0.1); // Lower finish beep

            stream.getTracks().forEach(track => track.stop());
            if (audioCtx) {
                audioCtx.close();
                audioCtx = null;
            }

            if (cancelPending) {
                cancelPending = false;
                return;
            }

            try {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const arrayBuffer = await audioBlob.arrayBuffer();
                const result = await ipcRenderer.invoke('transcribe-audio', arrayBuffer);

                micBtn.classList.remove('transcribing');
                micContainer.classList.remove('transcribing');

                if (result.success) {
                    micBtn.classList.add('show-check');
                    setTimeout(() => micBtn.classList.remove('show-check'), 1200);
                    setStatus('done', '✓ COPIED');
                    setTimeout(hideStatus, 1600);
                } else {
                    setStatus('err', result.error === 'No speech detected.' ? 'NO SPEECH' : 'ERROR');
                    setTimeout(hideStatus, 3000);
                }
            } catch (err) {
                micBtn.classList.remove('transcribing');
                micContainer.classList.remove('transcribing');
                setStatus('err', 'ERROR');
                setTimeout(hideStatus, 3000);
            }
        };

        mediaRecorder.start();
        isRecording = true;

        // ---- START FX ----
        micBtn.classList.add('pop');
        setTimeout(() => micBtn.classList.remove('pop'), 520);
        micBtn.classList.add('recording');
        micContainer.classList.add('recording');
        setStatus('', 'REC');

        drawVisualizer();
    } catch (err) {
        console.error("Microphone error:", err);
        setStatus('err', 'MIC UNAVAILABLE');
        setTimeout(hideStatus, 3000);
    }
}

function stopRecordingCore(cancel) {
    if (!isRecording) return;
    cancelPending = cancel;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    isRecording = false;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    // ---- FINISH FX ----
    micBtn.classList.remove('recording');
    micContainer.classList.remove('recording');
    micBtn.classList.add('burst');
    setTimeout(() => micBtn.classList.remove('burst'), 560);
    micContainer.classList.remove('finish');
    void micContainer.offsetWidth;
    micContainer.classList.add('finish');

    if (cancel) {
        setStatus('dim', 'CANCELLED');
        setTimeout(() => { if (!isRecording) hideStatus(); }, 1400);
    } else {
        // ---- TRANSCRIBING STATE (minimal spinner feedback) ----
        micBtn.classList.add('transcribing');
        micContainer.classList.add('transcribing');
        setStatus('busy', 'TRANSCRIBING');
    }
}

// Finish & transcribe (shortcut / future use)
function stopRecording() {
    stopRecordingCore(false);
}

// Abort recording, discard audio
function cancelRecording() {
    stopRecordingCore(true);
}

// Initial check on load
checkApiKeyStatus();
