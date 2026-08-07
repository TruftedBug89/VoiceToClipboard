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
const apiKeyNote = document.getElementById('api-key-note');
const removeKeyBtn = document.getElementById('remove-key-btn');
const canvas = document.getElementById('visualizer-canvas');
const canvasCtx = canvas.getContext('2d');
const micContainer = document.getElementById('mic-container');
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');

let isRecording = false;
let isStartingRecording = false;
let recordingSessionId = 0;
let mediaRecorder;
let audioChunks = [];
let cancelPending = false;

// Last completed recording kept in memory ONLY while a retry is possible.
// Cleared on success / new recording / cancel so audio never accumulates.
let lastAudio = null;

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
const localTierSelect = document.getElementById('local-tier-select');
const modelDropdown = document.getElementById('model-dropdown');
const modelDropdownBtn = document.getElementById('model-dropdown-btn');
const modelDropdownCurrent = document.getElementById('model-dropdown-current');
const modelDropdownChip = document.getElementById('model-dropdown-chip');
const modelDropdownPanel = document.getElementById('model-dropdown-panel');
const geminiKeyGroup = document.getElementById('gemini-key-group');
const geminiModelSelect = document.getElementById('gemini-model-select');
const modelCard = document.getElementById('model-card');
const modelCardName = document.getElementById('model-card-name');
const modelCardMeta = document.getElementById('model-card-meta');
const modelCardStatus = document.getElementById('model-card-status');
const modelCardDesc = document.getElementById('model-card-desc');
const modelCardLicense = document.getElementById('model-card-license');
const modelCardAction = document.getElementById('model-card-action');
const modelDownloadProgress = document.getElementById('model-download-progress');
const modelDownloadStatus = document.getElementById('model-download-status');
const modelDownloadPct = document.getElementById('model-download-pct');
const modelDownloadBar = document.getElementById('model-download-bar');
const modelCachePathEl = document.getElementById('model-cache-path');
const retryBtn = document.getElementById('retry-btn');

let selectedEngine = 'gemini';
let modelCatalog = [];
let modelStatusRequestId = 0;

function modelForSelection() {
    const tier = localTierSelect?.value || 'light';
    return modelCatalog.find(model => model.tier === tier) || null;
}

function formatDownloadSize(bytes) {
    if (!bytes) return 'size pending';
    return `${Math.round(bytes / (1024 * 1024))} MB download`;
}

function renderModelCard() {
    if (!modelCard) return;
    const model = modelForSelection();
    if (!model) {
        modelCard.style.display = 'none';
        return;
    }
    modelCard.style.display = 'block';
    modelCardName.textContent = model.name;
    const backendLabels = {
        omnilingual: 'Omnilingual',
        parakeet: 'Parakeet',
        'nemo-ctc': 'FastConformer CTC',
        'nemo-transducer': 'FastConformer Transducer',
        'sense-voice': 'SenseVoice',
        'fire-red-asr-ctc': 'FireRedASR2'
    };
    const backendLabel = backendLabels[model.backend] || model.name;
    modelCardMeta.textContent = `${backendLabel} · auto language · ${formatDownloadSize(model.downloadBytes)} · ${model.ramEstimate || ''}`;
    modelCardDesc.textContent = model.description;
    modelCardLicense.textContent = `License: ${model.license}`;
    if (model.verified === false) {
        modelCardStatus.textContent = '⚠️ Pending';
        modelCardStatus.className = 'status-pill download-needed';
    } else if (model.installed) {
        modelCardStatus.textContent = '✓ Installed';
        modelCardStatus.className = 'status-pill ready';
    } else {
        modelCardStatus.textContent = '⬇ Available';
        modelCardStatus.className = 'status-pill download-needed';
    }
    renderModelCardAction(model);
}

function renderModelCardAction(model) {
    if (!modelCardAction) return;
    modelCardAction.replaceChildren();
    if (!model.verified) {
        const note = document.createElement('div');
        note.style.cssText = 'font-size: 10px; color: var(--text-dim); line-height: 1.4;';
        note.textContent = model.unavailableReason || 'Compatibility pending for this runtime.';
        modelCardAction.append(note);
        return;
    }
    if (model.installed) {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; gap: 6px; align-items: center;';
        const ready = document.createElement('span');
        ready.style.cssText = 'flex: 1; font-size: 10px; color: #10b981; font-weight: 600;';
        ready.textContent = 'Ready to use locally';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-secondary';
        removeBtn.textContent = '🗑 Remove';
        removeBtn.style.cssText = 'padding: 5px 10px; font-size: 10px; white-space: nowrap;';
        removeBtn.addEventListener('click', async () => {
            await ipcRenderer.invoke('remove-local-model', model.key);
            await loadModelCatalog();
            checkModelStatus();
        });
        row.append(ready, removeBtn);
        modelCardAction.append(row);
        return;
    }
    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'btn-save';
    dlBtn.textContent = '📥 Download & Activate';
    dlBtn.style.cssText = 'padding: 7px 12px; font-size: 11px;';
    dlBtn.addEventListener('click', () => startModelDownload(model.key, dlBtn));
    modelCardAction.append(dlBtn);
}

function friendlyDownloadError(msg) {
    msg = String(msg || 'Unknown error');
    if (/base256|checksum|archive|tar|bzip/i.test(msg)) return 'The model archive could not be opened. Please try again.';
    if (/timed out|timeout/i.test(msg)) return 'Download timed out. Check your connection and retry.';
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|socket|getaddrinfo/i.test(msg)) return 'Network error — check your internet connection.';
    if (/HTTP \d{3}/i.test(msg)) return 'The server returned an error while downloading. Try again later.';
    if (/missing required files/i.test(msg)) return 'The downloaded model was incomplete. Try again.';
    return msg;
}

// ---- Custom model dropdown (futuristic picker) ----
const MODEL_TIER_LABELS = Object.freeze({
    tiny: { name: 'Tiny', recommended: false },
    mini: { name: 'Mini', recommended: false },
    'zh-light': { name: 'Chinese + English (Light)', recommended: false },
    light: { name: 'Light', recommended: true },
    big: { name: 'Big', recommended: false },
    'zh-big': { name: 'Chinese + English (Big)', recommended: false }
});

function dropdownSubLabel(model) {
    const size = formatDownloadSize(model.downloadBytes);
    const ram = String(model.ramEstimate || 'RAM estimate pending').trim();
    return `${model.name} · ${size} · ${ram}`;
}

function buildModelDropdown() {
    if (!modelDropdownPanel) return;
    modelDropdownPanel.replaceChildren();
    for (const model of modelCatalog) {
        const lbl = MODEL_TIER_LABELS[model.tier] || { name: model.name, recommended: false };
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'model-option';
        row.dataset.tier = model.tier;
        row.setAttribute('role', 'option');

        const main = document.createElement('span');
        main.className = 'mo-main';
        const name = document.createElement('span');
        name.className = 'mo-name';
        name.textContent = lbl.name;
        if (lbl.recommended) {
            const chip = document.createElement('span');
            chip.className = 'mo-chip';
            chip.textContent = '⭐ Recommended';
            name.appendChild(chip);
        }
        const sub = document.createElement('span');
        sub.className = 'mo-sub';
        sub.textContent = dropdownSubLabel(model);
        main.append(name, sub);

        const check = document.createElement('span');
        check.className = 'mo-check';
        check.textContent = '✓';

        row.append(main, check);
        if (model.tier === (localTierSelect?.value || 'light')) row.classList.add('selected');
        row.addEventListener('click', () => selectModelTier(model.tier));
        modelDropdownPanel.appendChild(row);
    }
    updateDropdownCurrent();
}

function updateDropdownCurrent() {
    if (!modelDropdownCurrent) return;
    const tier = localTierSelect?.value || 'light';
    const model = modelCatalog.find(m => m.tier === tier);
    const lbl = MODEL_TIER_LABELS[tier] || { name: model?.name || 'Light', recommended: false };
    modelDropdownCurrent.textContent = lbl.name;
    modelDropdownChip.style.display = lbl.recommended ? 'inline-flex' : 'none';
    for (const row of modelDropdownPanel?.querySelectorAll('.model-option') || []) {
        row.classList.toggle('selected', row.dataset.tier === tier);
    }
}

function selectModelTier(tier) {
    if (localTierSelect && localTierSelect.value !== tier) {
        localTierSelect.value = tier;
        localTierSelect.dispatchEvent(new Event('change'));
    }
    updateDropdownCurrent();
    closeModelDropdown();
}

function closeModelDropdown() {
    if (!modelDropdown) return;
    modelDropdown.classList.remove('open');
    if (modelDropdownPanel) modelDropdownPanel.style.display = 'none';
    if (modelDropdownBtn) modelDropdownBtn.setAttribute('aria-expanded', 'false');
}

if (modelDropdownBtn) {
    modelDropdownBtn.addEventListener('click', () => {
        const open = modelDropdownPanel.style.display !== 'block';
        modelDropdownPanel.style.display = open ? 'block' : 'none';
        modelDropdown.classList.toggle('open', open);
        modelDropdownBtn.setAttribute('aria-expanded', String(open));
        if (open) updateDropdownCurrent();
    });
}
document.addEventListener('click', (e) => {
    if (modelDropdown && modelDropdown.classList.contains('open') &&
        !modelDropdown.contains(e.target)) {
        closeModelDropdown();
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modelDropdown?.classList.contains('open')) closeModelDropdown();
});

async function loadModelCatalog() {
    modelCatalog = await ipcRenderer.invoke('get-model-catalog');
    renderModelCard();
    buildModelDropdown();
}

function setEngine(engine) {
    selectedEngine = engine;
    const isGemini = engine === 'gemini';
    engineBtnGemini.classList.toggle('active', isGemini);
    engineBtnLocal.classList.toggle('active', !isGemini);
    engineBtnGemini.setAttribute('aria-pressed', String(isGemini));
    engineBtnLocal.setAttribute('aria-pressed', String(!isGemini));
    localModelGroup.style.display = isGemini ? 'none' : 'flex';
    document.getElementById('eco-mode-group').style.display = isGemini ? 'none' : 'flex';
    geminiKeyGroup.style.display = isGemini ? 'flex' : 'none';
    updateLocalModelUi();
}

engineBtnGemini.addEventListener('click', () => {
    setEngine('gemini');
    autoSaveSettings();
});
engineBtnLocal.addEventListener('click', () => {
    setEngine('local');
    autoSaveSettings();
});

if (geminiModelSelect) {
    geminiModelSelect.addEventListener('change', () => autoSaveSettings());
}

// Convert webm audio blob to 16kHz mono Float32Array PCM for offline engines
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
    if (e.target.closest('input, select, button, .segment-btn, .toggle-switch, .slider, #close-modal-btn, #close-btn, #settings-btn, #cancel-btn, #retry-btn, a')) {
        return;
    }

    const isMicContainer = micContainer.contains(e.target);
    const isSettingsModal = settingsModal.contains(e.target);

    if (isMicContainer || isSettingsModal) {
        const dragTarget = isSettingsModal ? settingsModal : micContainer;
        pointerDrag = {
            pid: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            isMicClick: isMicContainer,
            dragTarget
        };
        lastPointerEventTime = Date.now();
        try { dragTarget.setPointerCapture(e.pointerId); } catch (err) {}
        ipcRenderer.send('drag-start');
    }
});

document.addEventListener('pointermove', (e) => {
    lastPointerEventTime = Date.now();
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

    if (!wasDrag && isMicClick && micContainer.contains(e.target) && !settingsModal.classList.contains('active')) {
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

// When the window flips click-through mid-drag, the OS drops pointer capture
// and the pointerup may never reach us — end the drag so the pill can wake.
document.addEventListener('lostpointercapture', (e) => {
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
let cursorInsideWindow = true; // authoritative state from main-process polling

// Wake-peek: when the cursor enters the widget, show the pill immediately so
// the user can always find Settings, then auto-hide it after a few seconds if
// the pointer is not over a trigger zone (top strip / record button).
let wakePeekUntil = 0;
let lastPointerEventTime = 0;

function refreshMouseIgnore() {
    // Safety: a missed pointerup (click-through + pointer capture quirks) can
    // leave pointerDrag stuck and permanently block the pill. If the pointer
    // has been silent for a while, treat the drag as dead.
    if (pointerDrag && Date.now() - lastPointerEventTime > 8000) endPointerDrag();
    if (pointerDrag) return; // never re-ignore mid-drag

    const isSettingsOpen = settingsModal.classList.contains('active');

    if (isSettingsWindow) return;

    if (isSettingsOpen) {
        topBar.classList.add('visible');
        if (mouseIgnored) {
            mouseIgnored = false;
            ipcRenderer.send('set-ignore-mouse', false);
        }
        return;
    }

    // The pill (settings/cancel/close) appears when the pointer is over the
    // top strip where the buttons live, or over the record button itself.
    // cursorInsideWindow is driven by main-process cursor polling (mouseleave
    // is unreliable with click-through + forward:true).
    const el = document.elementFromPoint(mouseX, mouseY);
    const overRecordButton = !!(el && el.closest('#mic-container'));
    const isMouseHoverTop = cursorInsideWindow && (
        (mouseY >= 0 && mouseY <= 60 && mouseX >= 0 && mouseX <= window.innerWidth) ||
        overRecordButton
    );

    if (isMouseHoverTop) {
        topBar.classList.add('hover-active');
    } else {
        topBar.classList.remove('hover-active');
    }

    const wakePeek = Date.now() < wakePeekUntil;
    if (isMouseHoverTop || isRecording || wakePeek) {
        topBar.classList.add('visible');
    } else {
        topBar.classList.remove('visible');
    }

    const interactive = !!(el && (
        el.closest('#mic-container') ||
        el.closest('#top-bar') ||
        el.closest('#settings-btn') ||
        el.closest('#cancel-btn') ||
        el.closest('#close-btn') ||
        el.closest('#retry-btn') ||
        el.closest('#settings-modal')
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
    cursorInsideWindow = false;
    wakePeekUntil = 0;
    document.body.classList.remove('is-hovering');
    if (pointerDrag) return;
    if (!settingsModal.classList.contains('active')) {
        topBar.classList.remove('visible', 'hover-active');
        if (!mouseIgnored) {
            mouseIgnored = true;
            ipcRenderer.send('set-ignore-mouse', true);
        }
    }
});

// Main-process cursor polling is the source of truth for hover/leave. The
// payload carries the real OS cursor position (window-relative) so the pill
// wakes instantly even when forwarded mouse events are missed.
ipcRenderer.on('widget-hover', (event, payload) => {
    const inside = typeof payload === 'boolean' ? payload : !!(payload && payload.inside);
    const entered = inside && !cursorInsideWindow;
    cursorInsideWindow = inside;
    if (!inside) {
        wakePeekUntil = 0;
        document.body.classList.remove('is-hovering');
        if (pointerDrag) return;
        if (!settingsModal.classList.contains('active') && !isRecording) {
            topBar.classList.remove('visible', 'hover-active');
            if (!mouseIgnored) {
                mouseIgnored = true;
                ipcRenderer.send('set-ignore-mouse', true);
            }
        }
        return;
    }
    if (payload && typeof payload === 'object' && typeof payload.x === 'number') {
        mouseX = payload.x;
        mouseY = payload.y;
    }
    // On wake-up (cursor enters the widget) always show the pill briefly so
    // Settings can always be found, then let it auto-hide if the pointer is
    // not over a trigger zone. Only re-arm on a real enter, not every tick.
    if (entered) wakePeekUntil = Date.now() + 3000;
    refreshMouseIgnore();
});

// Global Hotkey / IPC handlers
ipcRenderer.on('settings-changed', (event, snapshot) => {
    currentSttConfig = snapshot;
    applyAppearanceSnapshot(snapshot);
    if (isSettingsWindow) refreshSettingsUi(snapshot);
});

ipcRenderer.on('sync-settings', () => {
    refreshSettingsUi();
});

ipcRenderer.on('models-changed', async () => {
    await loadModelCatalog();
    if (geminiModelSelect) geminiModelSelect.value = sttConfig.geminiModel || 'gemini-2.5-flash';

    await checkModelStatus();
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
const resetThresholdBtn = document.getElementById('reset-threshold-btn');
const calibrateDurationSelect = document.getElementById('calibrate-duration-select');
const calibrateFeedback = document.getElementById('calibrate-feedback');
const noiseMeterBar = document.getElementById('noise-meter-bar');
const noiseMeterWrap = document.getElementById('noise-meter-wrap');
const noiseThresholdMarker = document.getElementById('noise-threshold-marker');
const noiseMeterStatus = document.getElementById('noise-meter-status');

const idleFadeCheckbox = document.getElementById('idle-fade-checkbox');
const idleFadeOptions = document.getElementById('idle-fade-options');
const idleOpacitySlider = document.getElementById('idle-opacity-slider');
const idleOpacityVal = document.getElementById('idle-opacity-val');

function applyIdleFadeState(enabled, opacityPct) {
    const decimalOpacity = (opacityPct / 100).toFixed(2);
    document.documentElement.style.setProperty('--idle-opacity', decimalOpacity);
    document.body.classList.toggle('idle-fade-active', !!enabled);
}

function applyAppearanceSnapshot(snapshot) {
    if (!snapshot) return;
    const idleOpacity = typeof snapshot.idleOpacity === 'number' ? Math.round(snapshot.idleOpacity * 100) : 60;
    applyIdleFadeState(snapshot.idleFadeEnabled, idleOpacity);
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
    // The live mic meter is only active during Auto-Calibrate now (keeps the
    // mic closed the rest of the time).
    if (!autoStopCheckbox.checked) {
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

if (resetThresholdBtn) {
    resetThresholdBtn.addEventListener('click', () => {
        const val = 12;
        if (silenceThresholdSlider) silenceThresholdSlider.value = val;
        if (thresholdValueDisplay) thresholdValueDisplay.textContent = val;
        if (currentSttConfig) currentSttConfig.silenceThreshold = val;
        if (calibrateFeedback) calibrateFeedback.textContent = 'Threshold reset to the default (12).';
        updateMeterUI(smoothedSpeechVolume, val);
        autoSaveSettings();
    });
}

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[idx];
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

const METER_MAX = 120;

function updateMeterUI(vol, threshold) {
    if (!noiseMeterBar || !noiseThresholdMarker || !noiseMeterStatus) return;
    const pct = Math.min(100, Math.max(0, Math.round((vol / METER_MAX) * 100)));
    const threshPct = Math.min(100, Math.max(0, Math.round((threshold / METER_MAX) * 100)));

    noiseMeterBar.style.width = `${pct}%`;
    noiseThresholdMarker.style.left = `${threshPct}%`;

    const ratio = threshold > 0 ? vol / threshold : 0;
    if (ratio > 1.15) {
        noiseMeterStatus.textContent = `Speech · ${Math.round(vol)}`;
        noiseMeterStatus.style.color = '#ef4444';
    } else if (ratio > 0.85) {
        noiseMeterStatus.textContent = `Near threshold · ${Math.round(vol)}`;
        noiseMeterStatus.style.color = '#f59e0b';
    } else {
        noiseMeterStatus.textContent = `Silent · ${Math.round(vol)}`;
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
    if (calibrateFeedback) { calibrateFeedback.style.color = ''; calibrateFeedback.textContent = ''; }

    // The live volume meter only appears while the test is running.
    if (noiseMeterWrap) noiseMeterWrap.style.display = 'block';

    const tempStream = settingsPreviewStream || await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    if (!tempStream) {
        if (calibrateFeedback) calibrateFeedback.textContent = 'Microphone access is unavailable — check your mic permissions.';
        autoCalibrateBtn.textContent = origText;
        autoCalibrateBtn.disabled = false;
        isCalibrating = false;
        if (noiseMeterWrap) noiseMeterWrap.style.display = 'none';
        return;
    }

    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const tempAnalyser = tempCtx.createAnalyser();
    tempAnalyser.fftSize = 64;
    const tempSrc = tempCtx.createMediaStreamSource(tempStream);
    tempSrc.connect(tempAnalyser);

    const durationSec = Math.min(10, Math.max(3, parseInt(calibrateDurationSelect?.value || '5', 10) || 5));

    const noiseSamples = [];
    let sec = durationSec;
    autoCalibrateBtn.textContent = `🤫 Listening… (${sec}s)`;
    if (calibrateFeedback) calibrateFeedback.textContent = `Don't talk — just let the background noise play for ${durationSec} seconds…`;
    const countdown = setInterval(() => {
        sec--;
        if (sec > 0) autoCalibrateBtn.textContent = `🤫 Listening… (${sec}s)`;
    }, 1000);

    const sampleLoop = setInterval(() => {
        const dataArr = new Uint8Array(tempAnalyser.frequencyBinCount);
        tempAnalyser.getByteFrequencyData(dataArr);
        const vol = calculateSpeechVolume(dataArr);
        smoothedSpeechVolume = smoothedSpeechVolume * 0.65 + vol * 0.35;
        noiseSamples.push(vol);
        const threshold = parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12;
        updateMeterUI(smoothedSpeechVolume, threshold);
    }, 50);

    await new Promise(resolve => setTimeout(resolve, durationSec * 1000));
    clearInterval(countdown);
    clearInterval(sampleLoop);
    try { tempCtx.close(); } catch (e) {}
    if (!settingsPreviewStream && tempStream) {
        tempStream.getTracks().forEach(t => t.stop());
    }

    // Robust stats: reject outliers with percentiles. Threshold = worst-case
    // background noise plus a comfortable margin so silence never stops a pause.
    const sorted = [...noiseSamples].sort((a, b) => a - b);
    const noiseP50 = percentile(sorted, 50);
    const noiseP90 = percentile(sorted, 90);
    let newThresh = Math.round(noiseP90 * 1.25 + 6);
    newThresh = Math.min(100, Math.max(2, newThresh));

    if (silenceThresholdSlider) silenceThresholdSlider.value = newThresh;
    if (thresholdValueDisplay) thresholdValueDisplay.textContent = newThresh;
    if (currentSttConfig) currentSttConfig.silenceThreshold = newThresh;
    autoSaveSettings();
    updateMeterUI(noiseP90, newThresh);

    if (calibrateFeedback) {
        calibrateFeedback.style.color = '#10b981';
        calibrateFeedback.textContent = gapWarn(noiseP50, noiseP90, newThresh);
    }

    autoCalibrateBtn.textContent = `✓ Set ${newThresh}`;
    setTimeout(() => {
        autoCalibrateBtn.textContent = origText;
        autoCalibrateBtn.disabled = false;
        isCalibrating = false;
        if (calibrateFeedback) calibrateFeedback.style.color = '';
        if (noiseMeterWrap) noiseMeterWrap.style.display = 'none';
        stopSettingsMicPreview();
    }, 2500);
}

function gapWarn(noiseP50, noiseP90, newThresh) {
    const mid = Math.round(noiseP50);
    const peak = Math.round(noiseP90);
    if (peak < 12) {
        return `Calibrated: background noise ~${mid} (very quiet room) → threshold ${newThresh}. Speak normally — if stops cut you off, raise it a bit.`;
    }
    if (peak > 70) {
        return `Calibrated: background noise ~${mid} (loud room!) → threshold ${newThresh}. You may want to move closer to the mic or reduce the noise.`;
    }
    return `Calibrated: background noise ~${mid} (peak ~${peak}) → threshold ${newThresh}.`;
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

async function refreshSettingsUi(snapshot = null) {
    const sttConfig = snapshot || await ipcRenderer.invoke('get-stt-config');
    applyAppearanceSnapshot(sttConfig);
    currentSttConfig = sttConfig;
    const cachePath = document.getElementById('model-cache-path');
    if (cachePath && sttConfig.modelCachePath) cachePath.textContent = `Cache: ${sttConfig.modelCachePath}`;
    const apiStatus = await ipcRenderer.invoke('get-api-key-status');

    await loadHotkey();
    setEngine(sttConfig.sttEngine || 'gemini');
    localTierSelect.value = sttConfig.localTier || 'light';
    updateDropdownCurrent();
    updateLocalModelUi();

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

function getSelectedModelKey() {
    return modelForSelection()?.key || 'omni-multilingual';
}

function updateLocalModelUi(config = currentSttConfig) {
    if (!localTierSelect) return;
    const tier = localTierSelect.value || config?.localTier || 'light';
    const selectedModel = modelForSelection();

    // Every model in the registry is multilingual/bilingual with automatic
    // language detection — the description comes straight from the registry.
    const modelNote = selectedModel?.verified === false
        ? (selectedModel?.unavailableReason || 'This model is not verified for the current runtime yet.')
        : (selectedModel?.description || 'Select a verified local model.');
}

async function checkModelStatus() {
    const requestId = ++modelStatusRequestId;
    const model = modelForSelection();
    const modelKey = model?.key || getSelectedModelKey();
    updateLocalModelUi();
    const res = await ipcRenderer.invoke('check-model-downloaded', modelKey);
    if (requestId !== modelStatusRequestId) return;
    const catalogModel = modelCatalog.find(m => m.key === modelKey);
    if (catalogModel) catalogModel.installed = !!res.downloaded;
    renderModelCard();
}

localTierSelect.addEventListener('change', () => {
    updateLocalModelUi();
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
if (cancelBtn) cancelBtn.addEventListener('click', cancelRecording);
if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
if (closeBtn) closeBtn.addEventListener('click', () => window.close());

let activeDownloadKey = null;

async function startModelDownload(modelKey, triggerBtn) {
    if (activeDownloadKey) return;
    activeDownloadKey = modelKey;

    modelDownloadProgress.style.display = 'block';
    modelDownloadStatus.textContent = 'Starting download…';
    modelDownloadPct.textContent = '0%';
    modelDownloadBar.style.width = '0%';
    if (triggerBtn) triggerBtn.disabled = true;
    modelCardStatus.textContent = '⬇ Downloading';
    modelCardStatus.className = 'status-pill download-needed';

    const downloadStats = {};
    const progressListener = (event, data) => {
        if (!data) return;
        if (data.status === 'progress' && data.file && data.loaded && data.total) {
            downloadStats[data.file] = { loaded: data.loaded, total: data.total };
            let totalLoaded = 0;
            let totalSize = 0;
            for (const key in downloadStats) {
                totalLoaded += downloadStats[key].loaded;
                totalSize += downloadStats[key].total;
            }
            if (totalSize > 0) {
                const pct = Math.min(100, Math.round((totalLoaded / totalSize) * 100));
                modelDownloadBar.style.width = `${pct}%`;
                modelDownloadPct.textContent = `${pct}%`;
                modelDownloadStatus.textContent = `Downloading… ${(totalLoaded / 1048576).toFixed(1)} / ${(totalSize / 1048576).toFixed(1)} MB`;
            }
        } else if (data.status === 'extracting') {
            modelDownloadStatus.textContent = 'Extracting & verifying…';
            modelDownloadBar.style.width = '100%';
            modelDownloadPct.textContent = '…';
        } else if (data.status === 'verified') {
            modelDownloadStatus.textContent = 'Verified ✓';
        }
    };

    ipcRenderer.on('download-progress', progressListener);
    const res = await ipcRenderer.invoke('download-local-model', modelKey);
    ipcRenderer.removeListener('download-progress', progressListener);
    activeDownloadKey = null;

    if (res.success) {
        await ipcRenderer.invoke('save-stt-config', {
            sttEngine: 'local',
            localTier: localTierSelect.value,
            autoStopEnabled: autoStopCheckbox.checked,
            autoStopSeconds: parseFloat(autoStopSecondsSelect.value),
            silenceThreshold: parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12,
            ecoMode: document.getElementById('eco-mode-checkbox').checked
        });
        modelDownloadStatus.textContent = 'Installed ✓';
        modelDownloadPct.textContent = '100%';
        modelDownloadBar.style.width = '100%';
        setStatus('done', '✓ MODEL READY');
        setTimeout(hideStatus, 2000);
        await loadModelCatalog();
        checkModelStatus();
        if (isSettingsWindow) {
            setTimeout(() => {
                modelDownloadProgress.style.display = 'none';
                modelDownloadBar.style.width = '0%';
            }, 1600);
        } else {
            setTimeout(closeSettings, 1200);
        }
    } else {
        modelDownloadStatus.textContent = `Download failed — ${friendlyDownloadError(res.error)}`;
        modelDownloadBar.style.width = '0%';
        modelDownloadPct.textContent = '—';
        modelCardStatus.textContent = '⚠️ Retry';
        modelCardStatus.className = 'status-pill download-needed';
        renderModelCardAction(modelForSelection());
    }
}

let autoSaveTimer = null;
let settingsSaveQueue = Promise.resolve();

function autoSaveSettings() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
        const save = async () => {
            const engine = selectedEngine;
            const localTier = localTierSelect.value;
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

            const geminiModel = geminiModelSelect ? geminiModelSelect.value : 'gemini-2.5-flash';
            const saved = await ipcRenderer.invoke('save-stt-config', {
                sttEngine: engine,
                localTier,
                localLanguage: 'auto',
                autoStopEnabled,
                autoStopSeconds,
                silenceThreshold,
                ecoMode,
                alwaysOnTop,
                idleFadeEnabled,
                idleOpacity,
                geminiModel
            });
            if (!saved.success) return;

            currentSttConfig = {
                sttEngine: engine,
                localTier,
                localLanguage: 'auto',
                localModelKey: getSelectedModelKey(),
                geminiModel: geminiModelSelect ? geminiModelSelect.value : 'gemini-2.5-flash',
                autoStopEnabled,
                autoStopSeconds,
                silenceThreshold,
                ecoMode,
                alwaysOnTop,
                idleFadeEnabled,
                idleOpacity
            };
        };
        settingsSaveQueue = settingsSaveQueue.then(save, save).catch(error => console.error('Settings save failed:', error));
    }, 150);
}

removeKeyBtn.addEventListener('click', async () => {
    await ipcRenderer.invoke('remove-api-key');
    refreshSettingsUi();
});

async function initializeRenderer() {
    await loadModelCatalog();
    const snapshot = await ipcRenderer.invoke('get-stt-config');
    applyAppearanceSnapshot(snapshot);
    if (isSettingsWindow) {
        settingsModal.classList.add('active');
        await refreshSettingsUi(snapshot);
    } else {
        currentSttConfig = snapshot;
    }
    await checkApiKeyStatus();
}

initializeRenderer().catch(error => console.error('Renderer initialization failed:', error));

// Draw circular audio waveform visualizer & check for VAD silence auto-stop
const smoothValues = new Array(32).fill(0);

let visualizerStartTime = 0;

// Always-running visualizer: a slow, clean rotating tick ring around the mic.
// Idle = gentle breathing rotation. Recording = smooth audio-reactive ticks on
// top of the same rotation, so it never looks like a static equalizer.
function drawVisualizer() {
    // Settings window hides the mic canvas - no need for the ring loop there.
    if (isSettingsWindow) return;
    if (!visualizerStartTime) visualizerStartTime = performance.now();
    const elapsed = (performance.now() - visualizerStartTime) / 1000;

    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const baseRadius = 31;

    let dataArray = null;
    let bufferLength = 0;
    if (analyser && isRecording) {
        bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);
        analyser.getByteFrequencyData(dataArray);

        // Frequency-weighted RMS volume for VAD silence auto-stop
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
                if (speechFramesCount >= 2) hasSpoken = true;
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
                            const remaining = Math.max(0.1, maxSec - silenceDurationSec).toFixed(1);
                            setStatus('busy', `PAUSE (${remaining}s)`);
                        }
                    }
                }
            }
        }
    }

    const bars = 32;
    const step = (Math.PI * 2) / bars;

    // Slow rotation - the whole ring drifts so the ticks always move.
    const rot = elapsed * 0.35;
    const isRecordingNow = !!(analyser && isRecording);
    // Gentle idle breath: amplitude oscillates slowly when not recording.
    const breath = isRecordingNow ? 1 : 0.55 + 0.45 * Math.sin(elapsed * 1.6);

    canvasCtx.lineCap = 'round';

    for (let i = 0; i < bars; i++) {
        let barHeight, intensity;
        if (isRecordingNow) {
            const binIndex = Math.min(bufferLength - 1, Math.floor((i * bufferLength) / bars));
            const target = dataArray[binIndex] || 0;
            smoothValues[i] += (target - smoothValues[i]) * 0.3;
            const val = smoothValues[i];
            // Base height so quiet moments still show a moving ring, not flat silence.
            barHeight = 4 + (val / 255) * 14;
            intensity = val / 255;
        } else {
            // Idle: uniform ticks that gently breathe (wave travels around the ring).
            const wave = 0.5 + 0.5 * Math.sin(elapsed * 1.6 - i * 0.55);
            barHeight = 3 + wave * 4;
            intensity = 0.18 + 0.1 * wave;
        }

        const angle = i * step + rot;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const x1 = centerX + cos * baseRadius;
        const y1 = centerY + sin * baseRadius;
        const h2 = baseRadius + barHeight * breath;
        const x2 = centerX + cos * h2;
        const y2 = centerY + sin * h2;

        const alpha = isRecordingNow ? (0.55 + intensity * 0.4) : (0.16 + intensity * 0.2);
        canvasCtx.strokeStyle = `rgba(230, 57, 70, ${alpha})`;
        canvasCtx.lineWidth = isRecordingNow ? (1.6 + intensity * 1.2) : 1.2;
        canvasCtx.shadowBlur = 0;

        canvasCtx.beginPath();
        canvasCtx.moveTo(x1, y1);
        canvasCtx.lineTo(x2, y2);
        canvasCtx.stroke();
    }

    // Thin guide ring, visible faintly so the circle reads as intentional.
    canvasCtx.strokeStyle = isRecordingNow ? 'rgba(230, 57, 70, 0.22)' : 'rgba(230, 57, 70, 0.14)';
    canvasCtx.lineWidth = 1;
    canvasCtx.beginPath();
    canvasCtx.arc(centerX, centerY, baseRadius + 1, 0, Math.PI * 2);
    canvasCtx.stroke();

    animationFrameId = requestAnimationFrame(drawVisualizer);
}

// Start the visualizer loop once at init (idle ring), not only while recording.
requestAnimationFrame(drawVisualizer);

function getRecorderMimeType() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm'];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

async function startRecording() {
    if (isRecording || isStartingRecording || micBtn.classList.contains('transcribing')) return;
    isStartingRecording = true;
    const sessionId = ++recordingSessionId;
    // A new recording supersedes any previous failed one — free its memory.
    lastAudio = null;
    hideRetryButton();
    let stream = null;
    try {
        stopSettingsMicPreview();
        setStatus('busy', 'STARTING');
        const sttConfig = await ipcRenderer.invoke('get-stt-config');
        currentSttConfig = sttConfig;
        hasSpoken = false;
        silenceStartTime = null;

        if (sttConfig.sttEngine === 'gemini') {
            const status = await ipcRenderer.invoke('get-api-key-status');
            if (!status.hasKey) {
                setStatus('err', 'NO API KEY');
                setTimeout(hideStatus, 2500);
                openSettings();
                return;
            }
        } else {
            if (!sttConfig.modelAvailable) {
                setStatus('err', 'MODEL UNAVAILABLE');
                setTimeout(hideStatus, 2500);
                openSettings();
                return;
            }
            if (!sttConfig.isDownloaded) {
                setStatus('err', 'MODEL NOT DOWNLOADED');
                setTimeout(hideStatus, 2500);
                openSettings();
                return;
            }
        }

        playBeep(880, 0.08);

        stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        // Setup Visualizer Node
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);

        const mimeType = getRecorderMimeType();
        mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        audioChunks = [];
        cancelPending = false;

        mediaRecorder.onerror = () => {
            if (sessionId !== recordingSessionId) return;
            cancelPending = true;
            setStatus('err', 'RECORDING FAILED');
        };
        mediaRecorder.ondataavailable = event => {
            if (sessionId === recordingSessionId && event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            playBeep(523, 0.1);
            stream.getTracks().forEach(track => track.stop());
            if (audioCtx) {
                try { await audioCtx.close(); } catch (error) {}
                audioCtx = null;
            }

            const chunks = audioChunks;
            audioChunks = [];
            if (cancelPending || sessionId !== recordingSessionId) {
                cancelPending = false;
                isStartingRecording = false;
                return;
            }

            try {
                const audioBlob = new Blob(chunks, { type: mimeType || 'audio/webm' });

                // Keep the recording in memory so "Transcribe Again" can resend it
                // if the first attempt fails (switch engine, add key, download
                // model, fix network — then retry). Cleared on success/next record.
                let float32Pcm = null;
                if (sttConfig.sttEngine === 'local') {
                    float32Pcm = await audioBlobTo16kHzFloat32(audioBlob);
                }
                lastAudio = {
                    blob: audioBlob,
                    pcm: float32Pcm,
                    mimeType: mimeType || 'audio/webm',
                    engine: sttConfig.sttEngine,
                    sampleRate: 16000
                };

                let result;
                if (sttConfig.sttEngine === 'local') {
                    // If the captured audio is essentially silent, the mic may be
                    // muted or set to a very low volume. Warn instead of sending
                    // silence to the model (which just yields a confusing NO SPEECH).
                    let sumSq = 0;
                    for (let i = 0; i < float32Pcm.length; i++) sumSq += float32Pcm[i] * float32Pcm[i];
                    const rms = float32Pcm.length ? Math.sqrt(sumSq / float32Pcm.length) : 0;
                    if (rms < 0.0004) {
                        // Only a truly dead/muted mic reaches here (digital silence).
                        // Real room noise is ~0.001+; real speech is ~0.01+.
                        lastAudio = null;
                        isStartingRecording = false;
                        micBtn.classList.remove('transcribing');
                        micContainer.classList.remove('transcribing');
                        setStatus('err', 'MIC TOO QUIET');
                        setTimeout(hideStatus, 3500);
                        return;
                    }
                    result = await ipcRenderer.invoke('transcribe-audio', {
                        engine: 'local',
                        modelKey: sttConfig.localModelKey,
                        pcm: float32Pcm.buffer,
                        sampleRate: 16000
                    });
                } else {
                    result = await ipcRenderer.invoke('transcribe-audio', {
                        engine: 'gemini',
                        arrayBuffer: await audioBlob.arrayBuffer(),
                        mimeType: mimeType || 'audio/webm'
                    });
                }

                if (sessionId !== recordingSessionId) return;
                micBtn.classList.remove('transcribing');
                micContainer.classList.remove('transcribing');
                isStartingRecording = false;

                if (result.success) {
                    lastAudio = null;
                    hideRetryButton();
                    micBtn.classList.add('show-check');
                    setTimeout(() => micBtn.classList.remove('show-check'), 1200);
                    setStatus('done', '✓ COPIED');
                    setTimeout(hideStatus, 1600);
                } else {
                    const status = result.code === 'NO_SPEECH' ? 'NO SPEECH' : (result.code === 'MODEL_UNAVAILABLE' ? 'MODEL UNAVAILABLE' : (result.code === 'NO_API_KEY' ? 'NO API KEY' : 'ERROR'));
                    setStatus('err', status);
                    if (isRetryableFailure(result.code)) {
                        showRetryButton();
                        setTimeout(hideStatus, 5000);
                    } else {
                        lastAudio = null;
                        setTimeout(hideStatus, 3000);
                    }
                }
            } catch (error) {
                if (sessionId !== recordingSessionId) return;
                isStartingRecording = false;
                micBtn.classList.remove('transcribing');
                micContainer.classList.remove('transcribing');
                setStatus('err', 'ERROR');
                if (lastAudio) showRetryButton();
                setTimeout(hideStatus, 4000);
            }
        };

        mediaRecorder.start();
        isStartingRecording = false;
        isRecording = true;
        document.body.classList.add('is-recording');

        // ---- START FX ----
        micBtn.classList.add('pop');
        setTimeout(() => micBtn.classList.remove('pop'), 520);
        micBtn.classList.add('recording');
        micContainer.classList.add('recording');
        setStatus('', 'REC');

    } catch (err) {
        if (stream) stream.getTracks().forEach(track => track.stop());
        if (audioCtx) {
            try { audioCtx.close(); } catch (error) {}
            audioCtx = null;
        }
        console.error("Microphone error:", err);
        setStatus('err', 'MIC UNAVAILABLE');
        setTimeout(hideStatus, 3000);
    } finally {
        isStartingRecording = false;
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
    smoothedSpeechVolume = 0;
    speechFramesCount = 0;
    silenceStartTime = null;
    hasSpoken = false;
    smoothValues.fill(0);
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
    lastAudio = null;
    hideRetryButton();
    stopRecordingCore(true);
}

// ---- Transcribe Again ----
// Codes where re-running the SAME audio with the current engine can succeed
// (e.g. after switching engine, adding an API key, or downloading a model).
function isRetryableFailure(code) {
    return code && code !== 'NO_SPEECH' && code !== 'MIC_TOO_QUIET';
}

function showRetryButton() {
    if (!retryBtn || !lastAudio) return;
    document.body.classList.add('has-retry');
    refreshMouseIgnore();
}

function hideRetryButton() {
    if (!retryBtn) return;
    document.body.classList.remove('has-retry');
    refreshMouseIgnore();
}

if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
        if (!lastAudio || isRecording) return;
        hideRetryButton();
        const audio = lastAudio;
        micBtn.classList.add('transcribing');
        micContainer.classList.add('transcribing');
        setStatus('busy', 'TRANSCRIBING');

        let result;
        try {
            const cfg = await ipcRenderer.invoke('get-stt-config');
            currentSttConfig = cfg;
            if (cfg.sttEngine === 'local') {
                result = await ipcRenderer.invoke('transcribe-audio', {
                    engine: 'local',
                    modelKey: cfg.localModelKey,
                    pcm: audio.pcm.buffer,
                    sampleRate: 16000
                });
            } else {
                result = await ipcRenderer.invoke('transcribe-audio', {
                    engine: 'gemini',
                    arrayBuffer: await audio.blob.arrayBuffer(),
                    mimeType: audio.mimeType
                });
            }
        } catch (error) {
            result = { success: false, code: 'TRANSCRIPTION_ERROR', error: String(error) };
        }

        micBtn.classList.remove('transcribing');
        micContainer.classList.remove('transcribing');

        if (result && result.success) {
            lastAudio = null;
            micBtn.classList.add('show-check');
            setTimeout(() => micBtn.classList.remove('show-check'), 1200);
            setStatus('done', '✓ COPIED');
            setTimeout(hideStatus, 1600);
        } else {
            const code = result?.code || 'ERROR';
            const status = code === 'NO_SPEECH' ? 'NO SPEECH' : (code === 'MODEL_UNAVAILABLE' ? 'MODEL UNAVAILABLE' : (code === 'NO_API_KEY' ? 'NO API KEY' : 'ERROR'));
            setStatus('err', status);
            if (isRetryableFailure(code)) {
                showRetryButton();
            } else {
                lastAudio = null;
            }
        }
    });
}

