const { ipcRenderer } = require('electron');

const isSettingsWindow = new URLSearchParams(window.location.search).get('settings') === '1';
if (isSettingsWindow) document.body.classList.add('settings-window');

const micBtn = document.getElementById('mic-button');
const closeBtn = document.getElementById('close-btn');
const cancelBtn = document.getElementById('cancel-btn');
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
        osc.onended = () => { try { ctx.close(); } catch (e) {} };
        osc.start();
        osc.stop(ctx.currentTime + duration);
    } catch (e) {}
}

// Minimal status indicator (dot + text)
function setStatus(mode, text) {
    if (statusText.textContent !== text) {
        statusText.textContent = text;
    }
    statusBadge.classList.remove('busy', 'done', 'dim', 'err');
    if (mode) statusBadge.classList.add(mode);
    statusBadge.classList.add('visible');
}

function hideStatus() {
    statusBadge.classList.remove('visible');
}

const engineBtnGemini = document.getElementById('engine-btn-gemini');
const engineBtnLocal = document.getElementById('engine-btn-local');
const localModelGroup = document.getElementById('local-model-group');
const localModelSelect = document.getElementById('local-model-select');
const geminiKeyGroup = document.getElementById('gemini-key-group');
const modelStatusInfo = document.getElementById('model-status-info');
const whisperInfoBanner = document.getElementById('whisper-info-banner');
const downloadModal = document.getElementById('download-modal');
const downloadPromptText = document.getElementById('download-prompt-text');
const confirmDownloadBtn = document.getElementById('confirm-download-btn');
const cancelDownloadBtn = document.getElementById('cancel-download-btn');
const downloadProgressContainer = document.getElementById('download-progress-container');
const downloadProgressBar = document.getElementById('download-progress-bar');
const downloadStatusText = document.getElementById('download-status-text');

let selectedEngine = 'gemini';
let pendingDownloadModel = null;

function setEngine(engine) {
    selectedEngine = engine;
    if (engine === 'gemini') {
        engineBtnGemini.classList.add('active');
        engineBtnLocal.classList.remove('active');
        localModelGroup.style.display = 'none';
        document.getElementById('eco-mode-group').style.display = 'none';
        geminiKeyGroup.style.display = 'flex';
    } else {
        engineBtnLocal.classList.add('active');
        engineBtnGemini.classList.remove('active');
        localModelGroup.style.display = 'flex';
        document.getElementById('eco-mode-group').style.display = 'flex';
        geminiKeyGroup.style.display = 'none';
    }
}

engineBtnGemini.addEventListener('click', () => {
    setEngine('gemini');
    autoSaveSettings();
});
engineBtnLocal.addEventListener('click', () => {
    setEngine('local');
    autoSaveSettings();
});

// Convert webm audio blob to 16kHz mono Float32Array PCM for Local Whisper
async function audioBlobTo16kHzFloat32(audioBlob) {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
        const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);

        const targetSampleRate = 16000;
        const offlineCtx = new OfflineAudioContext(1, Math.max(1, Math.ceil(audioBuffer.duration * targetSampleRate)), targetSampleRate);
        const sourceNode = offlineCtx.createBufferSource();
        sourceNode.buffer = audioBuffer;
        sourceNode.connect(offlineCtx.destination);
        sourceNode.start(0);

        const resampledBuffer = await offlineCtx.startRendering();
        return resampledBuffer.getChannelData(0);
    } finally {
        try { await tempCtx.close(); } catch (e) {}
    }
}

// ---- Custom drag & click logic (hold+drag moves the window, quick press toggles record/cancel) ----
const DRAG_THRESHOLD = 3;
let pointerDrag = null;

document.addEventListener('pointerdown', (e) => {
    if (isSettingsWindow) return;

    // Exclude interactive form controls from triggering window drag
    if (e.target.closest('input, select, button, .segment-btn, .toggle-switch, .slider, #close-modal-btn, #close-btn, #settings-btn, #cancel-btn, a')) {
        return;
    }

    const isMicContainer = micContainer.contains(e.target);
    const isSettingsModal = settingsModal.contains(e.target);
    const isDownloadModal = downloadModal.contains(e.target);

    if (isMicContainer || isSettingsModal || isDownloadModal) {
        const dragTarget = isSettingsModal ? settingsModal : (isDownloadModal ? downloadModal : micContainer);
        pointerDrag = {
            pid: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            isMicClick: isMicContainer,
            dragTarget
        };
        try { dragTarget.setPointerCapture(e.pointerId); } catch (err) {}
        ipcRenderer.send('drag-start');
    }
});

document.addEventListener('pointermove', (e) => {
    if (!pointerDrag || e.pointerId !== pointerDrag.pid) return;
    if (!pointerDrag.moved &&
        Math.abs(e.clientX - pointerDrag.startX) + Math.abs(e.clientY - pointerDrag.startY) > DRAG_THRESHOLD) {
        pointerDrag.moved = true;
        if (pointerDrag.dragTarget) pointerDrag.dragTarget.classList.add('dragging');
    }
    if (pointerDrag.moved) {
        ipcRenderer.send('drag-move');
    }
});

function endPointerDrag() {
    if (pointerDrag) {
        if (pointerDrag.dragTarget) {
            try { pointerDrag.dragTarget.releasePointerCapture(pointerDrag.pid); } catch (e) {}
            pointerDrag.dragTarget.classList.remove('dragging');
        }
        pointerDrag = null;
        micContainer.classList.remove('dragging');
        ipcRenderer.send('drag-end');
    }
}

document.addEventListener('pointerup', (e) => {
    if (!pointerDrag || e.pointerId !== pointerDrag.pid) return;
    const wasDrag = pointerDrag.moved;
    const isMicClick = pointerDrag.isMicClick;
    endPointerDrag();
    refreshMouseIgnore();

    if (!wasDrag && isMicClick && micContainer.contains(e.target) && !settingsModal.classList.contains('active') && !downloadModal.classList.contains('active')) {
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

const topBar = document.getElementById('top-bar');

// ---- Click-through transparent areas (only interactive spots capture the mouse) ----
let mouseIgnored = true;
let mouseX = 0, mouseY = 0;

function refreshMouseIgnore() {
    if (pointerDrag) return; // never re-ignore mid-drag

    const isSettingsOpen = settingsModal.classList.contains('active');
    const isDownloadOpen = downloadModal.classList.contains('active');

    if (isSettingsWindow) return;

    if (isSettingsOpen || isDownloadOpen) {
        topBar.classList.add('visible');
        if (mouseIgnored) {
            mouseIgnored = false;
            ipcRenderer.send('set-ignore-mouse', false);
        }
        return;
    }

    const isMouseHoverTop = mouseY >= 0 && mouseY <= 50 && mouseX >= 15 && mouseX <= 205;

    if (isMouseHoverTop) {
        topBar.classList.add('hover-active');
    } else {
        topBar.classList.remove('hover-active');
    }

    if (isMouseHoverTop || isRecording) {
        topBar.classList.add('visible');
    } else {
        topBar.classList.remove('visible');
    }

    const el = document.elementFromPoint(mouseX, mouseY);
    const interactive = !!(el && (
        el.closest('#mic-container') ||
        el.closest('#top-bar') ||
        el.closest('#settings-btn') ||
        el.closest('#cancel-btn') ||
        el.closest('#close-btn') ||
        el.closest('#settings-modal') ||
        el.closest('#download-modal')
    ));

    document.body.classList.toggle('is-hovering', interactive || isMouseHoverTop);

    const shouldIgnore = !interactive;
    if (shouldIgnore !== mouseIgnored) {
        mouseIgnored = shouldIgnore;
        ipcRenderer.send('set-ignore-mouse', shouldIgnore);
    }
}

document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    refreshMouseIgnore();
});

document.addEventListener('mouseleave', () => {
    document.body.classList.remove('is-hovering');
    if (pointerDrag) return;
    if (!settingsModal.classList.contains('active') && !downloadModal.classList.contains('active')) {
        topBar.classList.remove('visible');
        if (!mouseIgnored) {
            mouseIgnored = true;
            ipcRenderer.send('set-ignore-mouse', true);
        }
    }
});

// Global Hotkey / IPC handlers
ipcRenderer.on('sync-settings', () => {
    if (settingsModal.classList.contains('active')) {
        refreshSettingsUi();
    }
});

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

const autoStopCheckbox = document.getElementById('auto-stop-checkbox');
const autoStopOptions = document.getElementById('auto-stop-options');
const autoStopSecondsSelect = document.getElementById('auto-stop-seconds');
const silenceThresholdSlider = document.getElementById('silence-threshold-slider');
const thresholdValueDisplay = document.getElementById('threshold-value-display');
const autoCalibrateBtn = document.getElementById('auto-calibrate-btn');
const noiseMeterBar = document.getElementById('noise-meter-bar');
const noiseThresholdMarker = document.getElementById('noise-threshold-marker');
const noiseMeterStatus = document.getElementById('noise-meter-status');

const idleFadeCheckbox = document.getElementById('idle-fade-checkbox');
const idleFadeOptions = document.getElementById('idle-fade-options');
const idleOpacitySlider = document.getElementById('idle-opacity-slider');
const idleOpacityVal = document.getElementById('idle-opacity-val');

function applyIdleFadeState(enabled, opacityPct) {
    const decimalOpacity = (opacityPct / 100).toFixed(2);
    document.documentElement.style.setProperty('--idle-opacity', decimalOpacity);
    if (enabled) {
        document.body.classList.add('idle-fade-active');
    } else {
        document.body.classList.remove('idle-fade-active');
    }
}

if (idleFadeCheckbox) {
    idleFadeCheckbox.addEventListener('change', () => {
        const enabled = idleFadeCheckbox.checked;
        if (idleFadeOptions) idleFadeOptions.style.display = enabled ? 'flex' : 'none';
        const opacityPct = parseInt(idleOpacitySlider ? idleOpacitySlider.value : 30) || 30;
        applyIdleFadeState(enabled, opacityPct);
        autoSaveSettings();
    });
}

if (idleOpacitySlider) {
    idleOpacitySlider.addEventListener('input', () => {
        const pct = parseInt(idleOpacitySlider.value) || 30;
        if (idleOpacityVal) idleOpacityVal.textContent = `${pct}%`;
        applyIdleFadeState(idleFadeCheckbox ? idleFadeCheckbox.checked : false, pct);
        autoSaveSettings();
    });
}

autoStopCheckbox.addEventListener('change', () => {
    autoStopOptions.style.display = autoStopCheckbox.checked ? 'flex' : 'none';
    if (settingsModal.classList.contains('active') || isSettingsWindow) {
        startSettingsMicPreview();
    } else {
        stopSettingsMicPreview();
    }
    autoSaveSettings();
});

autoStopSecondsSelect.addEventListener('change', () => {
    autoSaveSettings();
});

if (silenceThresholdSlider) {
    silenceThresholdSlider.addEventListener('input', () => {
        const val = parseInt(silenceThresholdSlider.value) || 12;
        if (thresholdValueDisplay) thresholdValueDisplay.textContent = val;
        if (currentSttConfig) currentSttConfig.silenceThreshold = val;
        updateMeterUI(smoothedSpeechVolume, val);
        autoSaveSettings();
    });
}

// VAD / Silence Auto-Stop State
let currentSttConfig = null;
let hasSpoken = false;
let speechFramesCount = 0;
let silenceStartTime = null;
let smoothedSpeechVolume = 0;

// Preview mic context for settings live meter
let settingsPreviewStream = null;
let settingsPreviewAudioCtx = null;
let settingsPreviewAnalyser = null;
let settingsMeterFrameId = null;

// Calculate frequency-weighted RMS volume focused on vocal speech bands (~150Hz to 8kHz)
function calculateSpeechVolume(dataArray) {
    let sum = 0;
    let count = 0;
    const startBin = 2; // ~150 Hz
    const endBin = Math.min(dataArray.length, 24); // ~8 kHz
    for (let i = startBin; i < endBin; i++) {
        const val = dataArray[i];
        sum += val * val;
        count++;
    }
    if (count === 0) return 0;
    return Math.sqrt(sum / count);
}

function updateMeterUI(vol, threshold) {
    if (!noiseMeterBar || !noiseThresholdMarker || !noiseMeterStatus) return;
    const maxVal = 150;
    const pct = Math.min(100, Math.round((vol / maxVal) * 100));
    const threshPct = Math.min(100, Math.round((threshold / maxVal) * 100));

    noiseMeterBar.style.width = `${pct}%`;
    noiseThresholdMarker.style.left = `${threshPct}%`;

    if (vol > threshold) {
        noiseMeterStatus.textContent = `(Speech detected: ${Math.round(vol)})`;
        noiseMeterStatus.style.color = '#ef4444';
    } else {
        noiseMeterStatus.textContent = `(Silent: ${Math.round(vol)})`;
        noiseMeterStatus.style.color = '#10b981';
    }
}

async function startSettingsMicPreview() {
    if (isRecording || settingsPreviewStream) return;
    try {
        settingsPreviewStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        settingsPreviewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        settingsPreviewAnalyser = settingsPreviewAudioCtx.createAnalyser();
        settingsPreviewAnalyser.fftSize = 64;
        const previewSource = settingsPreviewAudioCtx.createMediaStreamSource(settingsPreviewStream);
        previewSource.connect(settingsPreviewAnalyser);

        function renderSettingsMeter() {
            if (!settingsPreviewAnalyser || isRecording || !settingsModal.classList.contains('active')) {
                stopSettingsMicPreview();
                return;
            }
            const bufferLen = settingsPreviewAnalyser.frequencyBinCount;
            const dataArr = new Uint8Array(bufferLen);
            settingsPreviewAnalyser.getByteFrequencyData(dataArr);

            const rawVol = calculateSpeechVolume(dataArr);
            smoothedSpeechVolume = smoothedSpeechVolume * 0.65 + rawVol * 0.35;

            const threshold = parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12;
            updateMeterUI(smoothedSpeechVolume, threshold);

            settingsMeterFrameId = requestAnimationFrame(renderSettingsMeter);
        }

        renderSettingsMeter();
    } catch (e) {
        console.warn("Settings mic preview unavailable:", e);
    }
}

function stopSettingsMicPreview() {
    if (settingsMeterFrameId) {
        cancelAnimationFrame(settingsMeterFrameId);
        settingsMeterFrameId = null;
    }
    if (settingsPreviewStream) {
        settingsPreviewStream.getTracks().forEach(t => t.stop());
        settingsPreviewStream = null;
    }
    if (settingsPreviewAudioCtx) {
        try { settingsPreviewAudioCtx.close(); } catch (e) {}
        settingsPreviewAudioCtx = null;
    }
    settingsPreviewAnalyser = null;
}

let isCalibrating = false;
async function autoCalibrateNoiseFloor() {
    if (isCalibrating) return;
    isCalibrating = true;
    const origText = autoCalibrateBtn.textContent;
    autoCalibrateBtn.disabled = true;

    const tempStream = settingsPreviewStream || await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    if (!tempStream) {
        autoCalibrateBtn.textContent = origText;
        autoCalibrateBtn.disabled = false;
        isCalibrating = false;
        return;
    }

    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const tempAnalyser = tempCtx.createAnalyser();
    tempAnalyser.fftSize = 64;
    const tempSrc = tempCtx.createMediaStreamSource(tempStream);
    tempSrc.connect(tempAnalyser);

    const silenceSamples = [];
    const speechSamples = [];

    let sec1 = 3;
    autoCalibrateBtn.textContent = `🤫 Silent... (${sec1}s)`;
    const t1 = setInterval(() => {
        sec1--;
        if (sec1 > 0) autoCalibrateBtn.textContent = `🤫 Silent... (${sec1}s)`;
    }, 1000);

    const sampleLoop = setInterval(() => {
        const dataArr = new Uint8Array(tempAnalyser.frequencyBinCount);
        tempAnalyser.getByteFrequencyData(dataArr);
        const vol = calculateSpeechVolume(dataArr);
        if (silenceSamples.length < 55) {
            silenceSamples.push(vol);
        } else {
            speechSamples.push(vol);
        }
    }, 50);

    setTimeout(() => {
        clearInterval(t1);
        let sec2 = 3;
        autoCalibrateBtn.textContent = `🗣️ Speak... (${sec2}s)`;
        const t2 = setInterval(() => {
            sec2--;
            if (sec2 > 0) autoCalibrateBtn.textContent = `🗣️ Speak... (${sec2}s)`;
        }, 1000);

        setTimeout(() => {
            clearInterval(t2);
            clearInterval(sampleLoop);
            try { tempCtx.close(); } catch (e) {}
            if (!settingsPreviewStream && tempStream) {
                tempStream.getTracks().forEach(t => t.stop());
            }

            const avgSilence = silenceSamples.length > 0 ? (silenceSamples.reduce((a, b) => a + b, 0) / silenceSamples.length) : 10;
            const avgSpeech = speechSamples.length > 0 ? (speechSamples.reduce((a, b) => a + b, 0) / speechSamples.length) : (avgSilence + 25);

            const diff = Math.max(10, avgSpeech - avgSilence);
            const newThresh = Math.min(95, Math.max(5, Math.round(avgSilence + (diff * 0.35))));

            if (silenceThresholdSlider) silenceThresholdSlider.value = newThresh;
            if (thresholdValueDisplay) thresholdValueDisplay.textContent = newThresh;
            if (currentSttConfig) currentSttConfig.silenceThreshold = newThresh;
            autoSaveSettings();
            updateMeterUI(avgSilence, newThresh);

            autoCalibrateBtn.textContent = `✓ Set ${newThresh}`;
            setTimeout(() => {
                autoCalibrateBtn.textContent = origText;
                autoCalibrateBtn.disabled = false;
                isCalibrating = false;
            }, 2000);
        }, 3000);
    }, 3000);
}

if (autoCalibrateBtn) {
    autoCalibrateBtn.addEventListener('click', autoCalibrateNoiseFloor);
}

async function checkApiKeyStatus() {
    const sttConfig = await ipcRenderer.invoke('get-stt-config');
    currentSttConfig = sttConfig;
    if (sttConfig.sttEngine === 'gemini') {
        const status = await ipcRenderer.invoke('get-api-key-status');
        if (!status.hasKey) {
            setStatus('err', 'API KEY REQUIRED');
        }
    } else {
        if (!sttConfig.isDownloaded) {
            setStatus('err', 'DOWNLOAD MODEL');
        }
    }
}

function openSettings() {
    if (isSettingsWindow) return;
    ipcRenderer.send('show-settings-window');
}

const hotkeyInput = document.getElementById('hotkey-input');
const recordHotkeyBtn = document.getElementById('record-hotkey-btn');
let isRecordingHotkey = false;

async function loadHotkey() {
    if (!hotkeyInput) return;
    const currentKey = await ipcRenderer.invoke('get-hotkey');
    hotkeyInput.value = currentKey || 'CommandOrControl+Alt+V';
}

function startHotkeyRecording() {
    if (!hotkeyInput || !recordHotkeyBtn) return;
    hotkeyInput.value = 'Press key or mouse btn...';
    hotkeyInput.style.borderColor = 'var(--primary)';
    recordHotkeyBtn.textContent = 'Listening...';
    
    ipcRenderer.invoke('start-recording-hotkey').then((newHotkeyStr) => {
        hotkeyInput.style.borderColor = 'rgba(255, 255, 255, 0.15)';
        recordHotkeyBtn.textContent = 'Change Key';
        if (newHotkeyStr) {
            hotkeyInput.value = newHotkeyStr;
            const note = document.getElementById('hotkey-note');
            if (note) note.innerHTML = '<span style="color: #10b981;">✓ Hotkey updated</span>';
            setTimeout(() => {
                if (note && note.innerHTML.includes('✓')) note.innerHTML = 'Click input or Change Key, then press key combination.';
            }, 3000);
        }
    });
}

if (hotkeyInput) hotkeyInput.addEventListener('click', startHotkeyRecording);
if (recordHotkeyBtn) recordHotkeyBtn.addEventListener('click', startHotkeyRecording);

async function refreshSettingsUi() {
    const sttConfig = await ipcRenderer.invoke('get-stt-config');
    currentSttConfig = sttConfig;
    const apiStatus = await ipcRenderer.invoke('get-api-key-status');

    await loadHotkey();
    setEngine(sttConfig.sttEngine || 'gemini');
    localModelSelect.value = sttConfig.localModel || 'Xenova/whisper-base';

    autoStopCheckbox.checked = !!sttConfig.autoStopEnabled;
    autoStopSecondsSelect.value = (sttConfig.autoStopSeconds || 3.5).toFixed(1);
    autoStopOptions.style.display = autoStopCheckbox.checked ? 'flex' : 'none';

    const silenceThreshold = typeof sttConfig.silenceThreshold === 'number' ? sttConfig.silenceThreshold : 12;
    if (silenceThresholdSlider) silenceThresholdSlider.value = silenceThreshold;
    if (thresholdValueDisplay) thresholdValueDisplay.textContent = silenceThreshold;
    updateMeterUI(smoothedSpeechVolume, silenceThreshold);

    document.getElementById('eco-mode-checkbox').checked = !!sttConfig.ecoMode;
    const alwaysOnTopCheckbox = document.getElementById('always-on-top-checkbox');
    if (alwaysOnTopCheckbox) alwaysOnTopCheckbox.checked = sttConfig.alwaysOnTop !== false;

    const idleFadeEnabled = !!sttConfig.idleFadeEnabled;
    const idleOpacity = typeof sttConfig.idleOpacity === 'number' ? Math.round(sttConfig.idleOpacity * 100) : 60;
    if (idleFadeCheckbox) idleFadeCheckbox.checked = idleFadeEnabled;
    if (idleFadeOptions) idleFadeOptions.style.display = idleFadeEnabled ? 'flex' : 'none';
    if (idleOpacitySlider) idleOpacitySlider.value = idleOpacity;
    if (idleOpacityVal) idleOpacityVal.textContent = `${idleOpacity}%`;
    applyIdleFadeState(idleFadeEnabled, idleOpacity);

    apiKeyInput.value = '';
    removeKeyBtn.style.display = apiStatus.source === 'config' ? 'inline-block' : 'none';
    if (apiStatus.source === 'env') {
        apiKeyNote.innerHTML = 'Key set via <code>GEMINI_API_KEY</code> environment var.';
    } else if (apiStatus.source === 'config') {
        apiKeyNote.textContent = '✓ Saved in app config.';
    } else {
        apiKeyNote.innerHTML = 'No key yet — get one at <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>.';
    }

    await checkModelStatus();
}

const whisperSupportedLanguages = 'English, Chinese, German, Spanish, Russian, Korean, French, Japanese, Portuguese, Turkish, Polish, Catalan, Dutch, Arabic, Swedish, Italian, Indonesian, Hindi, Finnish, Vietnamese, Hebrew, Ukrainian, Greek, Malay, Czech, Romanian, Danish, Hungarian, Tamil, Norwegian, Thai, Urdu, Croatian, Bulgarian, Lithuanian, Latin, Maori, Malayalam, Welsh, Slovak, Telugu, Persian, Latvian, Bengali, Serbian, Azerbaijani, Slovenian, Kannada, Estonian, Macedonian, Breton, Basque, Icelandic, Armenian, Nepali, Mongolian, Bosnian, Kazakh, Albanian, Swahili, Galician, Marathi, Punjabi, Sinhala, Khmer, Shona, Yoruba, Somali, Afrikaans, Occitan, Georgian, Belarusian, Tajik, Sindhi, Gujarati, Amharic, Yiddish, Lao, Uzbek, Faroese, Haitian Creole, Pashto, Turkmen, Nynorsk, Maltese, Sanskrit, Luxembourgish, Myanmar, Tibetan, Tagalog, Malagasy, Assamese, Tatar, Hawaiian, Lingala, Hausa, Bashkir, Javanese, Sundanese, Cantonese';

const whisperLanguageText = {
    'Xenova/whisper-tiny': `Whisper Tiny multilingual — 99 supported languages: ${whisperSupportedLanguages}. Accuracy varies by language; the separate tiny.en checkpoint is English-only and is not selected here.`,
    'Xenova/whisper-base': `Whisper Base multilingual — 99 supported languages: ${whisperSupportedLanguages}. Accuracy varies by language; the separate base.en checkpoint is English-only and is not selected here.`,
    'Xenova/whisper-small': `Whisper Small multilingual — 99 supported languages: ${whisperSupportedLanguages}. Accuracy varies by language; the separate small.en checkpoint is English-only and is not selected here.`,
    'Xenova/whisper-medium': `Whisper Medium multilingual — 99 supported languages: ${whisperSupportedLanguages}. Accuracy varies by language; the separate medium.en checkpoint is English-only and is not selected here.`,
    'Xenova/whisper-large-v3-turbo': `Whisper Large-v3 Turbo multilingual — 99 supported languages: ${whisperSupportedLanguages}. Accuracy varies by language; larger models generally handle lower-resource languages better.`
};

function updateWhisperLanguageInfo() {
    const text = whisperLanguageText[localModelSelect.value];
    if (text) whisperInfoBanner.textContent = text;
}

const triggerDownloadBtn = document.getElementById('trigger-download-btn');


async function checkModelStatus() {
    const modelId = localModelSelect.value;
    updateWhisperLanguageInfo();
    const res = await ipcRenderer.invoke('check-model-downloaded', modelId);
    if (res.downloaded) {
        modelStatusInfo.textContent = '✓ Model weights ready & cached';
        modelStatusInfo.className = 'status-pill ready';
        if (triggerDownloadBtn) triggerDownloadBtn.style.display = 'none';
    } else {
        modelStatusInfo.textContent = '⚠️ Download required';
        modelStatusInfo.className = 'status-pill download-needed';
        if (triggerDownloadBtn) triggerDownloadBtn.style.display = 'inline-block';
    }
}

if (triggerDownloadBtn) {
    triggerDownloadBtn.addEventListener('click', () => {
        promptDownloadModal(localModelSelect.value);
    });
}

localModelSelect.addEventListener('change', () => {
    checkModelStatus();
    autoSaveSettings();
});

document.getElementById('eco-mode-checkbox').addEventListener('change', () => {
    autoSaveSettings();
});

const alwaysOnTopCheckbox = document.getElementById('always-on-top-checkbox');
if (alwaysOnTopCheckbox) {
    alwaysOnTopCheckbox.addEventListener('change', () => {
        autoSaveSettings();
    });
}

apiKeyInput.addEventListener('change', () => {
    autoSaveSettings();
});

function closeSettings() {
    stopSettingsMicPreview();
    if (isSettingsWindow) {
        ipcRenderer.send('close-settings-window');
        return;
    }
    settingsModal.classList.remove('active');
    document.body.classList.remove('settings-active');
    refreshMouseIgnore();
}

if (closeModalBtn) closeModalBtn.addEventListener('click', closeSettings);
if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
if (closeBtn) closeBtn.addEventListener('click', () => window.close());

function promptDownloadModal(modelId) {
    pendingDownloadModel = modelId;
    downloadPromptText.textContent = `Local Whisper (${modelId}) requires downloading model weights into the application directory. Download now?`;
    downloadProgressContainer.style.display = 'none';
    downloadProgressBar.style.width = '0%';
    confirmDownloadBtn.style.display = 'inline-block';
    confirmDownloadBtn.disabled = false;
    cancelDownloadBtn.style.display = 'inline-block';
    downloadModal.classList.add('active');
}

function closeDownloadModal() {
    downloadModal.classList.remove('active');
    pendingDownloadModel = null;
    refreshMouseIgnore();
}

confirmDownloadBtn.addEventListener('click', async () => {
    if (!pendingDownloadModel) return;
    const modelId = pendingDownloadModel;
    confirmDownloadBtn.disabled = true;
    downloadProgressContainer.style.display = 'block';
    downloadStatusText.textContent = `Downloading ${modelId}... 0%`;

    const downloadStats = {};

    const progressListener = (event, data) => {
        if (data && data.status === 'progress' && data.file && data.loaded && data.total) {
            downloadStats[data.file] = { loaded: data.loaded, total: data.total };
            
            let totalLoaded = 0;
            let totalSize = 0;
            for (const key in downloadStats) {
                totalLoaded += downloadStats[key].loaded;
                totalSize += downloadStats[key].total;
            }
            
            if (totalSize > 0) {
                const pct = Math.round((totalLoaded / totalSize) * 100);
                downloadProgressBar.style.width = `${pct}%`;
                
                const mbLoaded = (totalLoaded / (1024 * 1024)).toFixed(1);
                const mbTotal = (totalSize / (1024 * 1024)).toFixed(1);
                downloadStatusText.textContent = `Downloading... ${pct}% (${mbLoaded}/${mbTotal} MB)`;
            }
        } else if (data && data.status === 'initiate' && data.file) {
            downloadStatusText.textContent = `Starting ${data.file}...`;
            cancelDownloadBtn.style.display = 'none';
        }
    };

    ipcRenderer.on('download-progress', progressListener);

    const res = await ipcRenderer.invoke('download-local-model', modelId);

    ipcRenderer.removeListener('download-progress', progressListener);

    if (res.success) {
        await ipcRenderer.invoke('save-stt-config', {
            sttEngine: 'local',
            localModel: modelId,
            autoStopEnabled: autoStopCheckbox.checked,
            autoStopSeconds: parseFloat(autoStopSecondsSelect.value),
            silenceThreshold: parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12,
            ecoMode: document.getElementById('eco-mode-checkbox').checked
        });
        setStatus('done', '✓ MODEL READY');
        setTimeout(hideStatus, 2000);
        closeDownloadModal();
        closeSettings();
    } else {
        downloadStatusText.textContent = `Download failed: ${res.error || 'Error'}`;
        confirmDownloadBtn.disabled = false;
    }
});

cancelDownloadBtn.addEventListener('click', () => {
    closeDownloadModal();
});

let autoSaveTimer = null;

async function autoSaveSettings() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
        const engine = selectedEngine;
        const localModel = localModelSelect.value;
        const autoStopEnabled = autoStopCheckbox.checked;
        const autoStopSeconds = parseFloat(autoStopSecondsSelect.value) || 3.5;
        const silenceThreshold = parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12;
        const ecoMode = document.getElementById('eco-mode-checkbox').checked;
        const alwaysOnTopCheckbox = document.getElementById('always-on-top-checkbox');
        const alwaysOnTop = alwaysOnTopCheckbox ? alwaysOnTopCheckbox.checked : true;
        const idleFadeEnabled = idleFadeCheckbox ? idleFadeCheckbox.checked : false;
        const idleOpacityPct = parseInt(idleOpacitySlider ? idleOpacitySlider.value : 60) || 60;
        const idleOpacity = idleOpacityPct / 100;

        const apiKeyVal = apiKeyInput.value.trim();
        if (apiKeyVal) {
            await ipcRenderer.invoke('save-api-key', apiKeyVal);
            apiKeyInput.value = '';
            await checkApiKeyStatus();
        }

        await ipcRenderer.invoke('save-stt-config', {
            sttEngine: engine,
            localModel,
            autoStopEnabled,
            autoStopSeconds,
            silenceThreshold,
            ecoMode,
            alwaysOnTop,
            idleFadeEnabled,
            idleOpacity
        });

        currentSttConfig = {
            sttEngine: engine,
            localModel,
            autoStopEnabled,
            autoStopSeconds,
            silenceThreshold,
            ecoMode,
            alwaysOnTop,
            idleFadeEnabled,
            idleOpacity
        };
    }, 150);
}

removeKeyBtn.addEventListener('click', async () => {
    await ipcRenderer.invoke('remove-api-key');
    refreshSettingsUi();
});

settingsBtn.addEventListener('click', openSettings);
cancelBtn.addEventListener('click', cancelRecording);
closeModalBtn.addEventListener('click', closeSettings);
closeBtn.addEventListener('click', () => window.close());

if (isSettingsWindow) {
    settingsModal.classList.add('active');
    refreshSettingsUi();
    startSettingsMicPreview();
}

// Draw circular audio waveform visualizer & check for VAD silence auto-stop
const smoothValues = new Array(32).fill(0);

function drawVisualizer() {
    if (!analyser || !isRecording) {
        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
        return;
    }

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    // Calculate frequency-weighted RMS volume for VAD silence auto-stop
    const currentVol = calculateSpeechVolume(dataArray);
    smoothedSpeechVolume = smoothedSpeechVolume * 0.65 + currentVol * 0.35;

    const silenceThresh = (currentSttConfig && typeof currentSttConfig.silenceThreshold === 'number')
        ? currentSttConfig.silenceThreshold
        : (parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12);

    if (settingsModal.classList.contains('active')) {
        updateMeterUI(smoothedSpeechVolume, silenceThresh);
    }

    if (currentSttConfig && currentSttConfig.autoStopEnabled) {
        if (smoothedSpeechVolume > silenceThresh) {
            speechFramesCount++;
            if (speechFramesCount >= 2) {
                hasSpoken = true;
            }
            if (silenceStartTime !== null) {
                silenceStartTime = null;
                setStatus('', 'REC');
            }
        } else {
            speechFramesCount = 0;
            if (hasSpoken) {
                if (!silenceStartTime) {
                    silenceStartTime = Date.now();
                } else {
                    const silenceDurationSec = (Date.now() - silenceStartTime) / 1000;
                    const maxSec = currentSttConfig.autoStopSeconds || 3.5;
                    if (silenceDurationSec >= maxSec) {
                        silenceStartTime = null;
                        hasSpoken = false;
                        stopRecording();
                        return;
                    } else if (silenceDurationSec > 0.3) {
                        // 300ms hangover period before displaying pause countdown
                        const remaining = Math.max(0.1, maxSec - silenceDurationSec).toFixed(1);
                        setStatus('busy', `🤫 PAUSE (${remaining}s)`);
                    }
                }
            }
        }
    }

    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const baseRadius = 31;

    // Subtle inner volume ring — pulses with overall loudness
    const overallLevel = Math.min(1, smoothedSpeechVolume / 40);
    if (overallLevel > 0.05) {
        canvasCtx.strokeStyle = `rgba(230, 57, 70, ${0.08 + overallLevel * 0.12})`;
        canvasCtx.lineWidth = 1;
        canvasCtx.beginPath();
        canvasCtx.arc(centerX, centerY, baseRadius - 2, 0, Math.PI * 2);
        canvasCtx.stroke();
    }

    const bars = 32;
    const step = (Math.PI * 2) / bars;

    canvasCtx.lineCap = 'round';

    for (let i = 0; i < bars; i++) {
        const binIndex = Math.min(bufferLength - 1, Math.floor((i * bufferLength) / bars));
        const target = dataArray[binIndex] || 0;
        smoothValues[i] += (target - smoothValues[i]) * 0.25;
        const val = smoothValues[i];
        const barHeight = (val / 255) * 16;
        const intensity = val / 255;

        const angle = i * step;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const x1 = centerX + cos * baseRadius;
        const y1 = centerY + sin * baseRadius;
        const x2 = centerX + cos * (baseRadius + barHeight);
        const y2 = centerY + sin * (baseRadius + barHeight);

        // Warm-to-hot color gradient: soft pink → ruby red → white-hot
        const r = 255;
        const g = Math.round(120 - intensity * 60);
        const b = Math.round(130 - intensity * 60);
        const alpha = 0.6 + intensity * 0.35;

        // Bar width varies slightly with intensity
        canvasCtx.lineWidth = 2 + intensity * 1.2;
        canvasCtx.shadowColor = `rgba(230, 57, 70, ${0.4 + intensity * 0.5})`;
        canvasCtx.shadowBlur = 4 + intensity * 6;

        canvasCtx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        canvasCtx.beginPath();
        canvasCtx.moveTo(x1, y1);
        canvasCtx.lineTo(x2, y2);
        canvasCtx.stroke();

        // Glow tip dot at bar peak when intensity is high enough
        if (intensity > 0.2 && barHeight > 2) {
            canvasCtx.fillStyle = `rgba(255, ${Math.round(180 - intensity * 80)}, ${Math.round(180 - intensity * 80)}, ${0.5 + intensity * 0.5})`;
            canvasCtx.shadowBlur = 6 + intensity * 4;
            canvasCtx.beginPath();
            canvasCtx.arc(x2, y2, 1 + intensity * 1, 0, Math.PI * 2);
            canvasCtx.fill();
        }
    }

    canvasCtx.shadowBlur = 0;

    // Outer guide ring
    canvasCtx.strokeStyle = 'rgba(230, 57, 70, 0.18)';
    canvasCtx.lineWidth = 1;
    canvasCtx.beginPath();
    canvasCtx.arc(centerX, centerY, baseRadius + 1, 0, Math.PI * 2);
    canvasCtx.stroke();

    animationFrameId = requestAnimationFrame(drawVisualizer);
}

async function startRecording() {
    if (micBtn.classList.contains('transcribing')) return;
    try {
        stopSettingsMicPreview();
        const sttConfig = await ipcRenderer.invoke('get-stt-config');
        currentSttConfig = sttConfig;
        hasSpoken = false;
        silenceStartTime = null;

        if (sttConfig.sttEngine === 'gemini') {
            const status = await ipcRenderer.invoke('get-api-key-status');
            if (!status.hasKey) {
                openSettings();
                return;
            }
        } else {
            if (!sttConfig.isDownloaded) {
                openSettings();
                return;
            }
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
                audioChunks = [];
                let result;

                if (sttConfig.sttEngine === 'local') {
                    const float32Pcm = await audioBlobTo16kHzFloat32(audioBlob);
                    result = await ipcRenderer.invoke('transcribe-audio-local', float32Pcm);
                } else {
                    const arrayBuffer = await audioBlob.arrayBuffer();
                    result = await ipcRenderer.invoke('transcribe-audio', arrayBuffer);
                }

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
        document.body.classList.add('is-recording');

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
    document.body.classList.remove('is-recording');
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
    audioChunks = [];
    stopRecordingCore(true);
}

// Initial check on load
checkApiKeyStatus();

