// window.api is injected by preload.js (contextIsolation: true, nodeIntegration: false).
// See preload.js for the full bridge surface.

// ─── i18n (offline, bundled locales) ───────────────────────────────────────
const LOCALES = window.api && window.api.locales ? window.api.locales : { en: {}, es: {}, zh: {} };
let uiLang = 'en';
let locale = LOCALES.en;

function t(key, vars, fallback) {
    let v = locale[key];
    if (v === undefined || v === null) v = LOCALES.en[key];
    if (v === undefined || v === null) v = (fallback !== undefined ? fallback : key);
    v = String(v);
    if (vars) {
        for (const k of Object.keys(vars)) v = v.split('{' + k + '}').join(String(vars[k]));
    }
    return v;
}
// Translate a status-code-ish message if a translation exists, else pass through.
function tr(msg) {
    if (typeof msg !== 'string') return msg;
    if (msg === '✓ COPIED') return t('status.COPIED');
    const norm = msg.trim().replace(/\s+/g, '_');
    const m = locale['status.' + norm];
    if (m !== undefined) return m;
    // dynamic messages like "PAUSE (1.3s)"
    if (msg.startsWith('PAUSE (')) return t('status.PAUSE') + msg.slice(5);
    if (msg.startsWith('REC')) return t('status.REC');
    return msg;
}
function applyI18n(lang) {
    uiLang = lang || 'en';
    locale = LOCALES[uiLang] || LOCALES.en;
    document.documentElement.lang = uiLang === 'zh' ? 'zh-CN' : (uiLang === 'es' ? 'es' : 'en');
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const val = t(key, null, el.textContent.trim());
        const hasElementChildren = Array.from(el.children).some(c => c.tagName !== 'BR');
        if (hasElementChildren) return; // icon buttons etc. — never wipe inner markup
        const onlyIcon = el.textContent.trim().length <= 3 && /[\u2190-\u27BF\u2B00-\u2BFF\uFE0F\u2600-\u27EF]/.test(el.textContent);
        if (onlyIcon) return; // glyph-only buttons (⚙️ ↻ ✕ …) keep their icon, only title translates
        el.textContent = val;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const label = t(el.getAttribute('data-i18n-title'));
        el.setAttribute('title', label);
        el.setAttribute('aria-label', label);
    });
    // Models note has an embedded styled span — rebuild innerHTML.
    const recoNote = document.getElementById('model-reco-note');
    if (recoNote) {
        const reco = '<span style="color: #ffd76a;">' + t('models.recommended') + '</span>';
        recoNote.innerHTML = t('models.note', { reco, ram: systemRamGB ? `(${systemRamGB} GB)` : '' });
    }
    if (typeof applyModelRecommendation === 'function') applyModelRecommendation(null);
    // live model dropdown + card re-render with new language
    try {
        if (typeof modelCatalog !== 'undefined' && modelCatalog && modelCatalog.length) {
            buildModelDropdown();
            renderModelCard();
        }
    } catch (e) { /* catalog may not be loaded yet */ }
}
function setUiLanguage(lang) {
    applyI18n(lang);
    applyModelRecommendation(null);
}

const isSettingsWindow = new URLSearchParams(window.location.search).get('settings') === '1';
if (isSettingsWindow) document.body.classList.add('settings-window');

const micBtn = document.getElementById('mic-button');
const closeBtn = document.getElementById('close-btn');
const cancelBtn = document.getElementById('cancel-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const apiKeyInput = document.getElementById('api-key-input');
const uiLanguageSelect = document.getElementById('ui-language-select');
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

// Soft two-tone "transcription finished" chime (E5 -> A5, gentle decay).
// Controlled by the "Sound when transcription finishes" setting.
function playFinishChime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const now = ctx.currentTime;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.09, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
        gain.connect(ctx.destination);
        const tones = [659.25, 880.0];
        tones.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = freq;
            osc.connect(gain);
            osc.start(now + idx * 0.12);
            osc.stop(now + 0.6 + idx * 0.12);
        });
        setTimeout(() => { try { ctx.close(); } catch (e) {} }, 900);
    } catch (e) {}
}

// Minimal status indicator (dot + text)
function setStatus(mode, text) {
    text = tr(text);
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

let selectedEngine = 'local';
let modelCatalog = [];
let modelStatusRequestId = 0;

function modelForSelection() {
    const tier = localTierSelect?.value || 'light';
    return modelCatalog.find(model => model.tier === tier) || null;
}

function formatDownloadSize(bytes) {
    if (!bytes) return t('model.sizePending');
    return t('model.mbDownload', { mb: Math.round(bytes / (1024 * 1024)) });
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
    modelCardMeta.textContent = t('model.cardMeta', { backend: backendLabel, lang: t('model.language.auto'), size: formatDownloadSize(model.downloadBytes), ram: model.ramEstimate || '' });
    modelCardDesc.textContent = model.description;
    modelCardLicense.textContent = `License: ${model.license}`;
    if (model.verified === false) {
        modelCardStatus.textContent = t('model.pending');
        modelCardStatus.className = 'status-pill download-needed';
    } else if (model.installed) {
        modelCardStatus.textContent = t('model.installed');
        modelCardStatus.className = 'status-pill ready';
    } else {
        modelCardStatus.textContent = '⬇ ' + t('model.available');
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
        note.textContent = model.unavailableReason || t('model.compatPending');
        modelCardAction.append(note);
        return;
    }
    if (model.installed) {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; gap: 6px; align-items: center;';
        const ready = document.createElement('span');
        ready.style.cssText = 'flex: 1; font-size: 10px; color: #10b981; font-weight: 600;';
        ready.textContent = t('model.ready');
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-secondary';
        removeBtn.textContent = t('model.remove');
        removeBtn.style.cssText = 'padding: 5px 10px; font-size: 10px; white-space: nowrap;';
        removeBtn.addEventListener('click', async () => {
            await window.api.removeLocalModel(model.key);
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
    dlBtn.textContent = t('model.downloadActivate');
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
    tiny: { name: 'Tiny' },
    mini: { name: 'Mini' },
    'zh-light': { name: 'Chinese + English (Light)' },
    light: { name: 'Light' },
    big: { name: 'Big' },
    'zh-big': { name: 'Chinese + English (Big)' }
});

// RAM-based recommendation (set from the main-process snapshot):
//   ≤4 GB Tiny · ≤8 GB Mini · ≤16 GB Light · >16 GB Big
let recommendedTier = 'light';
let systemRamGB = null;

function tierForLanguage(lang) {
    // The user picks the UI language; the same language is their speech hint.
    // Spanish/English -> nemo multilingual family (tiny/mini/big cover ES+EN).
    // Chinese -> SenseVoice / FireRedASR2 family. Unknown -> RAM-based default.
    if (lang === 'es') {
        return (systemRamGB !== null && systemRamGB <= 4) ? 'tiny' : 'mini';
    }
    if (lang === 'zh') return 'zh-light';
    return null; // en / auto: keep the RAM-based recommendation
}

function langRecoModelKey() {
    const tr = tierForLanguage(uiLang);
    if (!tr) return null;
    const byTier = (modelCatalog || []).filter(m => m.tier === tr);
    return byTier.length ? byTier[0].key : null;
}

function applyModelRecommendation(snapshot) {
    if (snapshot) {
        if (snapshot.recommendedTier) recommendedTier = snapshot.recommendedTier;
        if (typeof snapshot.systemRamGB === 'number') systemRamGB = snapshot.systemRamGB;
    }
    const langTier = tierForLanguage(uiLang);
    if (langTier) recommendedTier = langTier;
    const ramNote = document.getElementById('model-reco-ram');
    if (ramNote) ramNote.textContent = systemRamGB ? `(${systemRamGB} GB)` : '';
    // Language-aware note: "For Spanish speech, we recommend: Mini (10 languages)."
    const langNote = document.getElementById('model-lang-note');
    if (langNote) {
        const key = langRecoModelKey();
        if (key) {
            const model = (modelCatalog || []).find(m => m.key === key);
            const name = model ? t('model.' + key + '.name', null, model.name) : key;
            const langName = { es: 'Español', zh: '中文', en: 'English' }[uiLang] || 'English';
            langNote.textContent = t('models.langNote', { lang: langName, model: name });
            langNote.style.display = 'block';
        } else {
            langNote.style.display = 'none';
        }
    }
    if (modelDropdownPanel) buildModelDropdown();
}

function dropdownSubLabel(model) {
    const size = formatDownloadSize(model.downloadBytes);
    const ram = String(model.ramEstimate || t('model.sizePending')).trim();
    const localizedName = t('model.' + model.key + '.name', null, model.name);
    return `${localizedName} · ${size} · ${ram}`;
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
        name.textContent = t('models.tier.' + model.tier, null, lbl.name);
        if (model.tier === recommendedTier) {
            const chip = document.createElement('span');
            chip.className = 'mo-chip';
            chip.textContent = '⭐ ' + t('models.recommended', null, 'Recommended');
            name.appendChild(chip);
        }
        // Quality scales with size in this registry — flag the top tier so users
        // can pick accuracy when their PC has the RAM for it.
        if (model.tier === 'big' || model.tier === 'zh-big') {
            const chip = document.createElement('span');
            chip.className = 'mo-chip mo-chip-best';
            chip.textContent = '🏆 ' + t('models.bestQuality', null, 'Best quality');
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
        if (model.tier === (localTierSelect?.value || recommendedTier)) row.classList.add('selected');
        row.addEventListener('click', () => selectModelTier(model.tier));
        modelDropdownPanel.appendChild(row);
    }
    updateDropdownCurrent();
}

function updateDropdownCurrent() {
    if (!modelDropdownCurrent) return;
    const tier = localTierSelect?.value || recommendedTier;
    const model = modelCatalog.find(m => m.tier === tier);
    const lbl = MODEL_TIER_LABELS[tier] || { name: model?.name || 'Light' };
    modelDropdownCurrent.textContent = lbl.name;
    modelDropdownChip.style.display = tier === recommendedTier ? 'inline-flex' : 'none';
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
    modelCatalog = await window.api.getModelCatalog();
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
    const isMicButton = micBtn.contains(e.target);
    const isSettingsModal = settingsModal.contains(e.target);

    if (isMicContainer || isSettingsModal) {
        const dragTarget = isSettingsModal ? settingsModal : micContainer;
        pointerDrag = {
            pid: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            // Quick press toggles recording ONLY on the actual mic circle —
            // clicks on the transparent ring/margin area must pass through.
            isMicClick: isMicButton,
            dragTarget
        };
        lastPointerEventTime = Date.now();
        try { dragTarget.setPointerCapture(e.pointerId); } catch (err) {}
        window.api.dragStart();
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
        window.api.dragMove();
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
        window.api.dragEnd();
    }
}

document.addEventListener('pointerup', (e) => {
    if (!pointerDrag || e.pointerId !== pointerDrag.pid) return;
    const wasDrag = pointerDrag.moved;
    const isMicClick = pointerDrag.isMicClick;
    endPointerDrag();
    refreshMouseIgnore();

    if (!wasDrag && isMicClick && !settingsModal.classList.contains('active')) {
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

// Keyboard parity for the custom mic control; Escape cancels recording.
document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === micBtn) {
        e.preventDefault();
        if (!isRecording) startRecording();
        else stopRecording();
    } else if (isRecording && e.key === 'Escape') {
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
            window.api.setIgnoreMouse(false);
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

    // Click-through for transparent areas: only the VISIBLE interactive
    // elements (mic circle, pill buttons, retry) capture the pointer.
    // The invisible margins of the window let clicks pass through to the
    // app underneath — no more "invisible window eats my clicks".
    const hitEl = document.elementFromPoint(mouseX, mouseY);
    const overInteractiveEl = !!(hitEl && (hitEl.closest('#mic-button') || hitEl.closest('.icon-btn') || hitEl.closest('#retry-btn')));
    const interactive = overInteractiveEl || isSettingsOpen;

    document.body.classList.toggle('is-hovering', interactive);

    const shouldIgnore = !interactive;
    if (shouldIgnore !== mouseIgnored) {
        mouseIgnored = shouldIgnore;
        window.api.setIgnoreMouse(shouldIgnore);
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
            window.api.setIgnoreMouse(true);
        }
    }
});

// Main-process cursor polling is the source of truth for hover/leave. The
// payload carries the real OS cursor position (window-relative) so the pill
// wakes instantly even when forwarded mouse events are missed.
window.api.on('gemini-fallback', (model) => {
        setStatus('busy', `Rate limit — switched to ${model}`);
    });

window.api.on('widget-hover', (payload) => {
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
                window.api.setIgnoreMouse(true);
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
window.api.on('settings-changed', (snapshot) => {
    currentSttConfig = snapshot;
    applyAppearanceSnapshot(snapshot);
    // Live language switch: re-render the whole UI (widget + settings window).
    if (typeof snapshot.uiLanguage === 'string' && snapshot.uiLanguage !== uiLang) {
        setUiLanguage(snapshot.uiLanguage);
    }
    if (isSettingsWindow) refreshSettingsUi(snapshot);
});

window.api.on('sync-settings', () => {
    refreshSettingsUi();
});

window.api.on('models-changed', async () => {
    await loadModelCatalog();
    await checkModelStatus();
    updateLocalModelUi();
    buildModelDropdown();
    renderModelCard();
});

window.api.on('toggle-recording', () => {
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
});

window.api.on('open-settings', () => {
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

const WIDGET_STYLES = ['crimson', 'ocean', 'aurora', 'terminal'];

function applyAppearanceSnapshot(snapshot) {
    if (!snapshot) return;
    const idleOpacity = typeof snapshot.idleOpacity === 'number' ? Math.round(snapshot.idleOpacity * 100) : 60;
    applyIdleFadeState(snapshot.idleFadeEnabled, idleOpacity);
    if (typeof snapshot.widgetStyle === 'string') { currentWidgetStyle = WIDGET_STYLES.includes(snapshot.widgetStyle) ? snapshot.widgetStyle : 'crimson'; applyWidgetStyle(currentWidgetStyle); }
}


// Widget Style (theme) — mirrored into autoSaveSettings and applied live.
let currentWidgetStyle = 'crimson';
function setWidgetStyle(style, { save = true } = {}) {
    const s = WIDGET_STYLES.includes(style) ? style : 'crimson';
    currentWidgetStyle = s;
    applyWidgetStyle(s);
    if (save) autoSaveSettings();
}

function wireStylePicker() {
    const picker = document.getElementById('style-picker');
    if (!picker) return;
    const swatches = Array.from(picker.querySelectorAll('.style-swatch'));
    swatches.forEach((sw, idx) => {
        sw.addEventListener('click', () => setWidgetStyle(sw.getAttribute('data-style')));
        sw.addEventListener('keydown', (e) => {
            let next = null;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % swatches.length;
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + swatches.length) % swatches.length;
            else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setWidgetStyle(sw.getAttribute('data-style')); return; }
            if (next !== null) { e.preventDefault(); swatches[next].focus(); setWidgetStyle(swatches[next].getAttribute('data-style')); }
        });
    });
    // Reflect the persisted style on open.
    markActiveSwatch(picker, currentWidgetStyle);
}

// Theme: reflect the saved Widget Style onto <html data-widget-style="...">.
function applyWidgetStyle(style) {
    const s = WIDGET_STYLES.includes(style) ? style : 'crimson';
    document.documentElement.setAttribute('data-widget-style', s);
    const picker = document.getElementById('style-picker');
    if (picker) markActiveSwatch(picker, s);
}

function markActiveSwatch(picker, style) {
    for (const sw of picker.querySelectorAll('.style-swatch')) {
        const active = sw.getAttribute('data-style') === style;
        sw.classList.toggle('active', active);
        sw.setAttribute('aria-checked', active ? 'true' : 'false');
        sw.tabIndex = active ? 0 : -1;
    }
}

// Wire the Widget Style picker once (settings window).
wireStylePicker();

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

let pasteKeyVal = ' ';
const pasteStyleEl = document.getElementById('paste-style-select');
if (pasteStyleEl) {
    pasteStyleEl.addEventListener('change', () => {
        const row = document.getElementById('paste-key-row');
        if (row) row.style.display = pasteStyleEl.value === 'toast' ? 'none' : 'flex';
        autoSaveSettings();
    });
}
const pasteKeyInputEl = document.getElementById('paste-key-input');
if (pasteKeyInputEl) {
    pasteKeyInputEl.addEventListener('keydown', (e) => {
        e.preventDefault();
        pasteKeyVal = e.key;
        pasteKeyInputEl.value = e.key === ' ' ? 'SPACE' : e.key.toUpperCase();
        autoSaveSettings();
    });
    pasteKeyInputEl.addEventListener('focus', () => { pasteKeyInputEl.select(); });
}
// Toggles that auto-save on change. (Missing listeners here = settings that
// silently never persisted — spacePaste/finishSound were affected.)
const spacePasteToggleEl = document.getElementById('space-paste-checkbox');
if (spacePasteToggleEl) {
    spacePasteToggleEl.addEventListener('change', () => {
        autoSaveSettings();
    });
}
const finishSoundToggleEl = document.getElementById('finish-sound-checkbox');
if (finishSoundToggleEl) {
    finishSoundToggleEl.addEventListener('change', () => {
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
        if (calibrateFeedback) calibrateFeedback.textContent = t('autostop.thresholdReset');
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
let recordStartTime = 0;
let smoothedSpeechVolume = 0;
// Adaptive noise-floor VAD (see drawVisualizer): the effective silence
// threshold tracks the ambient floor so auto-stop survives room changes and
// thresholds calibrated in a noisy environment.
let noiseFloor = null;
let silenceAccumMs = 0;
let lastFrameTs = 0;
let vadDeadMicLogged = false;
let vadMin = 0, vadMax = 0, vadSum = 0, vadCount = 0;
let vadBlockEntries = 0, vadSpeechFrames = 0, vadSilenceFrames = 0, vadErrors = 0;
let vizErrLogged = false;
const NOISE_MARGIN = 8;
const MIN_VAD_THRESHOLD = 6;
const SPEECH_ARM_FRAMES = 3;

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
    autoCalibrateBtn.textContent = t('autostop.calibrate.listening', { s: sec });
    if (calibrateFeedback) calibrateFeedback.textContent = t('autostop.calibrate.dontTalk', { s: durationSec });
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
        return t('autostop.calibrate.quiet', { mid, newThresh });
    }
    if (peak > 70) {
        return t('autostop.calibrate.loud', { mid, newThresh });
    }
    return t('autostop.calibrate.normal', { mid, peak, newThresh });
}

if (autoCalibrateBtn) {
    autoCalibrateBtn.addEventListener('click', autoCalibrateNoiseFloor);
}

async function checkApiKeyStatus() {
    const sttConfig = await window.api.getSttConfig();
    currentSttConfig = sttConfig;
    if (sttConfig.sttEngine === 'gemini') {
        const status = await window.api.getApiKeyStatus();
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
    window.api.showSettingsWindow();
}

const hotkeyInput = document.getElementById('hotkey-input');
const recordHotkeyBtn = document.getElementById('record-hotkey-btn');
let isRecordingHotkey = false;

async function loadHotkey() {
    if (!hotkeyInput) return;
    const currentKey = await window.api.getHotkey();
    hotkeyInput.value = currentKey || 'CommandOrControl+Alt+V';
}

function startHotkeyRecording() {
    if (!hotkeyInput || !recordHotkeyBtn) return;
    hotkeyInput.value = 'Press key or mouse btn...';
    hotkeyInput.style.borderColor = 'var(--primary)';
    recordHotkeyBtn.textContent = t('autostop.calibrate.listening', { s: '…' });
    
    window.api.startRecordingHotkey().then((newHotkeyStr) => {
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
    const sttConfig = snapshot || await window.api.getSttConfig();
    applyAppearanceSnapshot(sttConfig);
    currentSttConfig = sttConfig;
    applyI18n(sttConfig.uiLanguage || 'en');
    if (uiLanguageSelect) uiLanguageSelect.value = sttConfig.uiLanguage || 'en';
    const cachePath = document.getElementById('model-cache-path');
    if (cachePath && sttConfig.modelCachePath) cachePath.textContent = `${t('models.cachePath')} (${sttConfig.modelCachePath})`;
    const recPathDisplay = document.getElementById('recordings-path-display');
    if (recPathDisplay && sttConfig.recordingsPath) recPathDisplay.textContent = sttConfig.recordingsPath;
    const apiStatus = await window.api.getApiKeyStatus();

    await loadHotkey();
    applyModelRecommendation(sttConfig);
    setEngine(sttConfig.sttEngine || 'local');
    localTierSelect.value = sttConfig.localTier || recommendedTier;
    updateDropdownCurrent();
    updateLocalModelUi();
    const finishSoundCheckbox = document.getElementById('finish-sound-checkbox');
    if (finishSoundCheckbox) finishSoundCheckbox.checked = sttConfig.playFinishSound !== false;

    autoStopCheckbox.checked = !!sttConfig.autoStopEnabled;
    const spacePasteCheckbox = document.getElementById('space-paste-checkbox');
    if (spacePasteCheckbox) spacePasteCheckbox.checked = sttConfig.spacePaste === true;
    const pasteKeyInput = document.getElementById('paste-key-input');
    if (pasteKeyInput) {
        const rawKey = (typeof sttConfig.pasteKey === 'string' && sttConfig.pasteKey) ? sttConfig.pasteKey : ' ';
        pasteKeyVal = rawKey;
        pasteKeyInput.value = rawKey === ' ' ? 'SPACE' : rawKey.toUpperCase();
    }
    const pasteStyleSelect = document.getElementById('paste-style-select');
    if (pasteStyleSelect) {
        pasteStyleSelect.value = sttConfig.pasteStyle === 'toast' ? 'toast' : 'bubble';
        const pasteKeyRow = document.getElementById('paste-key-row');
        if (pasteKeyRow) pasteKeyRow.style.display = sttConfig.pasteStyle === 'toast' ? 'none' : 'flex';
    }
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
    const saveRecordingsCheckbox = document.getElementById('save-recordings-checkbox');
    const recordingsFolderDetails = document.getElementById('recordings-folder-details');
    if (saveRecordingsCheckbox) {
        const isSaveEnabled = !!sttConfig.saveRecordings;
        saveRecordingsCheckbox.checked = isSaveEnabled;
        if (recordingsFolderDetails) {
            recordingsFolderDetails.style.display = isSaveEnabled ? 'block' : 'none';
        }
    }

    apiKeyInput.value = '';
    removeKeyBtn.style.display = (apiStatus.source === 'config' || (apiStatus.count || 0) > 0) ? 'inline-block' : 'none';
    const nKeys = apiStatus.count || 0;
    if (apiStatus.source === 'env' && nKeys <= 1) {
        apiKeyNote.innerHTML = 'Key set via <code>GEMINI_API_KEY</code> environment var.';
    } else if (nKeys > 0) {
        apiKeyNote.textContent = nKeys === 1 ? '✓ 1 key saved in app config.' : `✓ ${nKeys} keys saved — rate-limited keys are skipped automatically.`;
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
    const res = await window.api.checkModelDownloaded(modelKey);
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

const saveRecordingsCheckbox = document.getElementById('save-recordings-checkbox');
if (saveRecordingsCheckbox) {
    saveRecordingsCheckbox.addEventListener('change', () => {
        const recordingsFolderDetails = document.getElementById('recordings-folder-details');
        if (recordingsFolderDetails) {
            recordingsFolderDetails.style.display = saveRecordingsCheckbox.checked ? 'block' : 'none';
        }
        autoSaveSettings();
    });
}

function closeSettings() {
    stopSettingsMicPreview();
    if (isSettingsWindow) {
        window.api.closeSettingsWindow();
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
const openRecordingsBtn = document.getElementById('open-recordings-btn');
if (openRecordingsBtn) {
    openRecordingsBtn.addEventListener('click', async () => {
        if (window.api && window.api.openRecordingsFolder) {
            await window.api.openRecordingsFolder();
        }
    });
}

let activeDownloadKey = null;
let downloadSpinnerEl = null;

function addDownloadSpinner() {
    if (!modelDownloadStatus || downloadSpinnerEl) return;
    downloadSpinnerEl = document.createElement('span');
    downloadSpinnerEl.className = 'download-spinner';
    downloadSpinnerEl.setAttribute('aria-hidden', 'true');
    modelDownloadStatus.appendChild(downloadSpinnerEl);
}

function removeDownloadSpinner() {
    if (!downloadSpinnerEl) return;
    downloadSpinnerEl.remove();
    downloadSpinnerEl = null;
}

async function startModelDownload(modelKey, triggerBtn) {
    removeDownloadSpinner();
    if (activeDownloadKey) return;
    activeDownloadKey = modelKey;

    modelDownloadProgress.style.display = 'block';
    modelDownloadStatus.textContent = t('model.downloadStarting');
    modelDownloadPct.textContent = '0%';
    modelDownloadBar.style.width = '0%';
    if (triggerBtn) triggerBtn.disabled = true;
    modelCardStatus.textContent = '⬇ ' + t('model.downloading');
    modelCardStatus.className = 'status-pill download-needed';

    const downloadStats = {};
    const progressListener = (data) => {
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
                modelDownloadStatus.textContent = t('model.downloading2', { a: (totalLoaded / 1048576).toFixed(1), b: (totalSize / 1048576).toFixed(1) });
            }
        } else if (data.status === 'extracting') {
            // Extraction has no byte counter — show an indeterminate spinner
            // and pulse the bar so it is obvious the app is busy, not frozen.
            modelDownloadStatus.textContent = t('model.extracting');
            addDownloadSpinner();
            modelDownloadBar.classList.add('extracting');
            modelDownloadBar.style.width = '100%';
            modelDownloadPct.textContent = '…';
        } else if (data.status === 'verified') {
            modelDownloadBar.classList.remove('extracting');
            removeDownloadSpinner();
            modelDownloadStatus.textContent = t('model.verified');
        }
    };

    window.api.on('download-progress', progressListener);
    const res = await window.api.downloadLocalModel(modelKey);
    window.api.removeListener('download-progress', progressListener);
    activeDownloadKey = null;

    if (res.success) {
        await window.api.saveSttConfig({
            sttEngine: 'local',
            localTier: localTierSelect.value,
            autoStopEnabled: autoStopCheckbox.checked,
            autoStopSeconds: parseFloat(autoStopSecondsSelect.value),
            silenceThreshold: parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12,
            ecoMode: document.getElementById('eco-mode-checkbox').checked
        });
        removeDownloadSpinner();
        modelDownloadBar.classList.remove('extracting');
        modelDownloadStatus.textContent = t('model.installed');
        modelDownloadPct.textContent = '100%';
        modelDownloadBar.style.width = '100%';
        setStatus('done', '✓ MODEL READY');
        setTimeout(hideStatus, 2000);
        // Refresh from disk truth, then force every consumer re-render in THIS
        // window (broadcastModelsChanged covers the other one). The previous
        // checkModelStatus() alone left renderModelCard()/'installed' stale when
        // the request-id guard dropped the earlier refresh.
        await loadModelCatalog();
        await checkModelStatus();
        updateLocalModelUi();
        buildModelDropdown();
        renderModelCard();
        if (isSettingsWindow) {
            setTimeout(() => {
                modelDownloadProgress.style.display = 'none';
                modelDownloadBar.style.width = '0%';
            }, 1600);
        } else {
            setTimeout(closeSettings, 1200);
        }
    } else {
        modelDownloadStatus.textContent = t('model.downloadFailed', { err: friendlyDownloadError(res.error) });
        modelDownloadBar.style.width = '0%';
        modelDownloadPct.textContent = '—';
        modelCardStatus.textContent = t('model.retry');
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
            const finishSoundCheckbox = document.getElementById('finish-sound-checkbox');
            const playFinishSound = finishSoundCheckbox ? finishSoundCheckbox.checked : true;
            const alwaysOnTopCheckbox = document.getElementById('always-on-top-checkbox');
            const alwaysOnTop = alwaysOnTopCheckbox ? alwaysOnTopCheckbox.checked : true;
            const idleFadeEnabled = idleFadeCheckbox ? idleFadeCheckbox.checked : false;
            const idleOpacityPct = parseInt(idleOpacitySlider ? idleOpacitySlider.value : 60) || 60;
            const idleOpacity = idleOpacityPct / 100;

            const keyLines = apiKeyInput.value.split('\n').map(s => s.trim()).filter(Boolean);
            if (keyLines.length) {
                await window.api.saveApiKey(keyLines);
                apiKeyInput.value = '';
                await checkApiKeyStatus();
            }

            const saved = await window.api.saveSttConfig({
                sttEngine: engine,
                uiLanguage: uiLanguageSelect ? uiLanguageSelect.value : uiLang,
                localTier,
                localLanguage: 'auto',
                autoStopEnabled,
                autoStopSeconds,
                silenceThreshold,
                ecoMode,
                alwaysOnTop,
                idleFadeEnabled,
                idleOpacity,
                playFinishSound,
                spacePaste: document.getElementById('space-paste-checkbox')
                    ? document.getElementById('space-paste-checkbox').checked
                    : false,
                pasteStyle: document.getElementById('paste-style-select')
                    ? document.getElementById('paste-style-select').value
                    : 'bubble',
                pasteKey: pasteKeyVal,
                widgetStyle: currentWidgetStyle,
                saveRecordings: saveRecordingsCheckbox ? saveRecordingsCheckbox.checked : false
            });
            if (!saved.success) return;

            currentSttConfig = {
                sttEngine: engine,
                localTier,
                localLanguage: 'auto',
                localModelKey: getSelectedModelKey(),
                autoStopEnabled,
                autoStopSeconds,
                silenceThreshold,
                ecoMode,
                alwaysOnTop,
                idleFadeEnabled,
                idleOpacity,
                saveRecordings: saveRecordingsCheckbox ? saveRecordingsCheckbox.checked : false
            };
        };
        settingsSaveQueue = settingsSaveQueue.then(save, save).catch(error => console.error('Settings save failed:', error));
    }, 150);
}

removeKeyBtn.addEventListener('click', async () => {
    await window.api.removeApiKey();
    refreshSettingsUi();
});

async function initializeRenderer() {
    await loadModelCatalog();
    const snapshot = await window.api.getSttConfig();
    applyAppearanceSnapshot(snapshot);
    applyI18n(snapshot.uiLanguage || 'en');
    if (isSettingsWindow) {
        settingsModal.classList.add('active');
        await refreshSettingsUi(snapshot);
    } else {
        currentSttConfig = snapshot;
        applyModelRecommendation(snapshot);
    }
    await checkApiKeyStatus();
}

initializeRenderer().catch(error => console.error('Renderer initialization failed:', error));

// Draw circular audio waveform visualizer & check for VAD silence auto-stop
const smoothValues = new Array(32).fill(0);

const auroraParticles = Array.from({ length: 24 }, () => ({
    x: (Math.random() - 0.5) * 80,
    y: (Math.random() - 0.5) * 80,
    radius: 2 + Math.random() * 4,
    vx: (Math.random() - 0.5) * 0.4,
    vy: -0.3 - Math.random() * 0.5,
    alpha: 0.2 + Math.random() * 0.6,
    phase: Math.random() * Math.PI * 2
}));

const terminalPeaks = new Array(14).fill(0);
const terminalPeakDecay = new Array(14).fill(0);

function getStyleColors(style) {
    switch (style) {
        case 'ocean':
            return { r: 14, g: 165, b: 233, hex: '#0ea5e9', hover: '#38bdf8' };
        case 'aurora':
            return { r: 168, g: 85, b: 247, hex: '#a855f7', hover: '#c084fc' };
        case 'terminal':
            return { r: 0, g: 255, b: 102, hex: '#00ff66', hover: '#55ff99' };
        case 'crimson':
        default:
            return { r: 230, g: 57, b: 70, hex: '#e63946', hover: '#ff4d4d' };
    }
}

let visualizerStartTime = 0;

// Always-running visualizer: style-aware audio-reactive visualizer routines.
function drawVisualizer() {
    // Settings window hides the mic canvas - no need for the loop there.
    if (isSettingsWindow) return;
    try {
    if (!visualizerStartTime) visualizerStartTime = performance.now();
    const elapsed = (performance.now() - visualizerStartTime) / 1000;

    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    let dataArray = null;
    let bufferLength = 0;
    if (analyser && isRecording) {
        bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);
        analyser.getByteFrequencyData(dataArray);

        // Frequency-weighted RMS volume for VAD silence auto-stop
        const currentVol = calculateSpeechVolume(dataArray);
        smoothedSpeechVolume = smoothedSpeechVolume * 0.65 + currentVol * 0.35;
        vadMin = vadCount === 0 ? smoothedSpeechVolume : Math.min(vadMin, smoothedSpeechVolume);
        vadMax = Math.max(vadMax, smoothedSpeechVolume);
        vadSum += smoothedSpeechVolume;
        vadCount++;

        const silenceThresh = (currentSttConfig && typeof currentSttConfig.silenceThreshold === 'number')
            ? currentSttConfig.silenceThreshold
            : (parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12);

        if (settingsModal.classList.contains('active')) {
            updateMeterUI(smoothedSpeechVolume, silenceThresh);
        }

        if (currentSttConfig && currentSttConfig.autoStopEnabled) {
            vadBlockEntries++;
            if (vadBlockEntries === 1) log(`[render] VAD block entered | cfgKeys=${Object.keys(currentSttConfig).filter(k => k.startsWith('auto')).join(',')}`);
            try {
            if (noiseFloor === null) {
                noiseFloor = Math.max(4, smoothedSpeechVolume);
            } else if (smoothedSpeechVolume < noiseFloor) {
                noiseFloor = noiseFloor * 0.6 + smoothedSpeechVolume * 0.4;
            } else {
                noiseFloor = noiseFloor * 0.9995 + smoothedSpeechVolume * 0.0005;
            }
            const effectiveThresh = Math.max(MIN_VAD_THRESHOLD, Math.min(silenceThresh, noiseFloor + NOISE_MARGIN));

            const nowTs = performance.now();
            const frameDt = lastFrameTs ? Math.min(200, nowTs - lastFrameTs) : 16;
            lastFrameTs = nowTs;

            if (smoothedSpeechVolume > effectiveThresh) {
                vadSpeechFrames++;
                speechFramesCount++;
                if (speechFramesCount >= SPEECH_ARM_FRAMES) hasSpoken = true;
                if (silenceAccumMs > 0) silenceAccumMs = Math.max(0, silenceAccumMs - frameDt);
                if (silenceStartTime !== null) {
                    silenceStartTime = null;
                    setStatus('', 'REC');
                }
            } else {
                vadSilenceFrames++;
                speechFramesCount = 0;
                if (!hasSpoken && Date.now() - recordStartTime > 8000 && !vadDeadMicLogged) {
                    vadDeadMicLogged = true;
                    log(`[render] VAD watchdog: no speech armed after 8s (smoothed=${smoothedSpeechVolume.toFixed(1)}, thresh=${silenceThresh}, ctx=${audioCtx ? audioCtx.state : 'none'}) — mic may be muted or silent`);
                }
                if (hasSpoken && Date.now() - recordStartTime >= 2000) {
                    if (silenceStartTime === null) silenceStartTime = Date.now();
                    silenceAccumMs += frameDt;
                    const maxSec = currentSttConfig.autoStopSeconds || 3.5;
                    if (silenceAccumMs >= maxSec * 1000) {
                        silenceStartTime = null;
                        hasSpoken = false;
                        stopRecording();
                        return;
                    } else if (silenceAccumMs > 300) {
                        const remaining = Math.max(0.1, maxSec - silenceAccumMs / 1000).toFixed(1);
                        setStatus('busy', `PAUSE (${remaining}s)`);
                    }
                }
            }
            } catch (vadErr) {
                vadErrors++;
                if (vadErrors <= 3) log(`[render] VAD exception: ${String(vadErr && vadErr.stack ? vadErr.stack : vadErr).slice(0, 300)}`);
            }
        }
    }

    const isRecordingNow = !!(analyser && isRecording);
    const col = getStyleColors(currentWidgetStyle);

    if (currentWidgetStyle === 'ocean') {
        // Mode: Ocean — Scrolling Tide Waveform
        const wavePoints = 40;
        const width = canvas.width;
        const baseLine = centerY + 36;
        const breath = isRecordingNow ? 1 : 0.5 + 0.5 * Math.sin(elapsed * 1.5);

        canvasCtx.beginPath();
        canvasCtx.moveTo(0, baseLine);
        for (let i = 0; i <= wavePoints; i++) {
            const x = (i / wavePoints) * width;
            let amp = 0;
            if (isRecordingNow && dataArray && bufferLength > 0) {
                const bin = Math.min(bufferLength - 1, Math.floor((i / wavePoints) * (bufferLength / 2)));
                amp = (dataArray[bin] / 255) * 24;
            } else {
                amp = Math.sin(elapsed * 2.5 + i * 0.3) * 4 * breath;
            }
            const y = baseLine - Math.sin(elapsed * 3 + (i / wavePoints) * Math.PI * 4) * (6 + amp);
            if (i === 0) canvasCtx.moveTo(x, y);
            else canvasCtx.lineTo(x, y);
        }
        canvasCtx.lineTo(width, canvas.height);
        canvasCtx.lineTo(0, canvas.height);
        canvasCtx.closePath();

        const grad = canvasCtx.createLinearGradient(0, baseLine - 20, 0, canvas.height);
        const alpha = isRecordingNow ? 0.45 : 0.25;
        grad.addColorStop(0, `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha})`);
        grad.addColorStop(1, `rgba(${col.r}, ${col.g}, ${col.b}, 0)`);
        canvasCtx.fillStyle = grad;
        canvasCtx.fill();

        canvasCtx.lineWidth = isRecordingNow ? 2.5 : 1.5;
        canvasCtx.strokeStyle = `rgba(${col.r}, ${col.g}, ${col.b}, ${isRecordingNow ? 0.9 : 0.5})`;
        canvasCtx.shadowColor = `rgba(${col.r}, ${col.g}, ${col.b}, 0.6)`;
        canvasCtx.shadowBlur = isRecordingNow ? 8 : 2;
        canvasCtx.stroke();
        canvasCtx.shadowBlur = 0;

    } else if (currentWidgetStyle === 'aurora') {
        // Mode: Aurora — Floating Bloom Particle Field
        const intensity = (isRecordingNow && dataArray) ? (smoothedSpeechVolume / 100) : 0.3;

        auroraParticles.forEach((p) => {
            p.y += p.vy * (1 + intensity * 1.5);
            p.x += Math.sin(elapsed * 1.2 + p.phase) * 0.3;
            if (p.y < -60 || p.x < -60 || p.x > 60) {
                p.x = (Math.random() - 0.5) * 80;
                p.y = 40 + Math.random() * 20;
            }

            const px = centerX + p.x;
            const py = centerY + p.y;
            const r = Math.max(1, p.radius * (1 + intensity * 0.8));
            const alpha = Math.min(1, p.alpha * (0.6 + intensity * 0.8));

            const pGrad = canvasCtx.createRadialGradient(px, py, 0, px, py, r * 2.5);
            pGrad.addColorStop(0, `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha})`);
            pGrad.addColorStop(0.5, `rgba(192, 132, 252, ${alpha * 0.5})`);
            pGrad.addColorStop(1, 'transparent');

            canvasCtx.fillStyle = pGrad;
            canvasCtx.beginPath();
            canvasCtx.arc(px, py, r * 2.5, 0, Math.PI * 2);
            canvasCtx.fill();
        });

    } else if (currentWidgetStyle === 'terminal') {
        // Mode: Terminal — Blocky Digital Equalizer Bars
        const barCount = 14;
        const barWidth = 6;
        const barGap = 3;
        const totalW = barCount * (barWidth + barGap) - barGap;
        const startX = centerX - totalW / 2;
        const blockHeight = 3;
        const blockGap = 1.5;
        const maxBlocks = 12;

        for (let i = 0; i < barCount; i++) {
            let level = 0;
            if (isRecordingNow && dataArray && bufferLength > 0) {
                const bin = Math.min(bufferLength - 1, Math.floor((i / barCount) * (bufferLength / 2)));
                level = smoothValues[i] = (smoothValues[i] || 0) * 0.7 + (dataArray[bin] / 255) * 0.3;
            } else {
                const wave = 0.2 + 0.15 * Math.sin(elapsed * 3 + i * 0.4);
                level = wave;
            }

            const activeBlocks = Math.round(level * maxBlocks);
            const x = startX + i * (barWidth + barGap);

            if (activeBlocks >= terminalPeaks[i]) {
                terminalPeaks[i] = activeBlocks;
                terminalPeakDecay[i] = elapsed;
            } else if (elapsed - terminalPeakDecay[i] > 0.2) {
                terminalPeaks[i] = Math.max(0, terminalPeaks[i] - 0.4);
            }

            for (let b = 0; b < maxBlocks; b++) {
                const y = centerY + 46 - b * (blockHeight + blockGap);
                const isActive = b < activeBlocks;
                const isPeak = Math.floor(terminalPeaks[i]) === b && b > 0;

                if (isActive || isPeak) {
                    const alpha = isPeak ? 1.0 : (0.4 + (b / maxBlocks) * 0.6);
                    canvasCtx.fillStyle = `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha})`;
                    canvasCtx.shadowColor = `rgba(${col.r}, ${col.g}, ${col.b}, 0.8)`;
                    canvasCtx.shadowBlur = isPeak ? 6 : 2;
                } else {
                    canvasCtx.fillStyle = `rgba(${col.r}, ${col.g}, ${col.b}, 0.08)`;
                    canvasCtx.shadowBlur = 0;
                }

                canvasCtx.fillRect(x, y, barWidth, blockHeight);
            }
        }
        canvasCtx.shadowBlur = 0;

    } else {
        // Mode: Crimson — Radiating Rings
        const bars = 32;
        const step = (Math.PI * 2) / bars;
        const baseRadius = 29;
        const rot = elapsed * 0.35;
        const breath = isRecordingNow ? 1 : 0.55 + 0.45 * Math.sin(elapsed * 1.6);

        canvasCtx.lineCap = 'round';

        for (let i = 0; i < bars; i++) {
            let barHeight, intensity;
            if (isRecordingNow) {
                const binIndex = Math.min(bufferLength - 1, Math.floor((i * bufferLength) / bars));
                const target = dataArray[binIndex] || 0;
                smoothValues[i] += (target - smoothValues[i]) * 0.3;
                const val = smoothValues[i];
                barHeight = 6 + (val / 255) * 22;
                intensity = val / 255;
            } else {
                const wave = 0.5 + 0.5 * Math.sin(elapsed * 1.6 - i * 0.55);
                barHeight = 4 + wave * 5;
                intensity = 0.35 + 0.25 * wave;
            }

            const angle = i * step + rot;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            const x1 = centerX + cos * baseRadius;
            const y1 = centerY + sin * baseRadius;
            const h2 = baseRadius + barHeight * breath;
            const x2 = centerX + cos * h2;
            const y2 = centerY + sin * h2;

            const alpha = isRecordingNow ? (0.7 + intensity * 0.3) : (0.35 + intensity * 0.25);
            canvasCtx.strokeStyle = `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha})`;
            canvasCtx.lineWidth = isRecordingNow ? (2 + intensity * 2) : 1.6;
            if (isRecordingNow) {
                canvasCtx.shadowColor = `rgba(${col.r}, ${col.g}, ${col.b}, 0.55)`;
                canvasCtx.shadowBlur = 6 + intensity * 6;
            } else {
                canvasCtx.shadowColor = 'transparent';
                canvasCtx.shadowBlur = 0;
            }

            canvasCtx.beginPath();
            canvasCtx.moveTo(x1, y1);
            canvasCtx.lineTo(x2, y2);
            canvasCtx.stroke();
        }

        canvasCtx.strokeStyle = isRecordingNow
            ? `rgba(${col.r}, ${col.g}, ${col.b}, 0.3)`
            : `rgba(${col.r}, ${col.g}, ${col.b}, 0.22)`;
        canvasCtx.lineWidth = 1;
        canvasCtx.beginPath();
        canvasCtx.arc(centerX, centerY, baseRadius + 1, 0, Math.PI * 2);
        canvasCtx.stroke();
    }

    } catch (vizErr) {
        if (!vizErrLogged) {
            vizErrLogged = true;
            log(`[render] visualizer exception: ${String(vizErr && vizErr.stack ? vizErr.stack : vizErr).slice(0, 400)}`);
        }
    } finally {
        animationFrameId = requestAnimationFrame(drawVisualizer);
    }
}

// Hidden widget: stop burning GPU/CPU on the idle ring; resume on visibility.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
    } else if (!animationFrameId) {
        animationFrameId = requestAnimationFrame(drawVisualizer);
    }
});

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
    // A new recording supersedes any previous one — free its memory.
    lastAudio = null;
    hideRetryButton();
    refreshRetranscribeBtn();
    let stream = null;
    try {
        stopSettingsMicPreview();
        window.api.widgetRaise();
        setStatus('busy', 'STARTING');
        const sttConfig = await window.api.getSttConfig();
        currentSttConfig = sttConfig;
        log(`[render] record start | autoStop=${!!sttConfig.autoStopEnabled} (${sttConfig.autoStopSeconds}s) | threshold=${sttConfig.silenceThreshold} | engine=${sttConfig.sttEngine}`);
        hasSpoken = false;
        silenceStartTime = null;
        noiseFloor = null;
        silenceAccumMs = 0;
        lastFrameTs = 0;
        vadDeadMicLogged = false;
        vadMin = 0; vadMax = 0; vadSum = 0; vadCount = 0;
        vadBlockEntries = 0; vadSpeechFrames = 0; vadSilenceFrames = 0; vadErrors = 0;

        if (sttConfig.sttEngine === 'gemini') {
            const status = await window.api.getApiKeyStatus();
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
        // Chromium can create the context 'suspended' (autoplay policy, or after
        // a previous context closed) — without resume the analyser feeds zeros
        // and VAD auto-stop goes blind (recording never stops on its own).
        if (audioCtx.state === 'suspended') {
            try { await audioCtx.resume(); } catch (error) { /* analyser stays silent; watchdog below will flag it */ }
        }
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
                        refreshRetranscribeBtn();
                        setStatus('err', 'MIC TOO QUIET');
                        setTimeout(hideStatus, 3500);
                        return;
                    }
                    result = await window.api.transcribeAudio({
                        engine: 'local',
                        modelKey: sttConfig.localModelKey,
                        pcm: float32Pcm.buffer,
                        sampleRate: 16000,
                        uiLanguage: uiLang
                    });
                } else {
                    result = await window.api.transcribeAudio({
                        engine: 'gemini',
                        arrayBuffer: await audioBlob.arrayBuffer(),
                        mimeType: mimeType || 'audio/webm',
                        uiLanguage: uiLang
                    });
                }

                if (sessionId !== recordingSessionId) return;
                micBtn.classList.remove('transcribing');
                micContainer.classList.remove('transcribing');
                isStartingRecording = false;

                if (result.success) {
                    // Keep the audio in memory so the re-transcribe (↻) button
                    // can run it again with a different model/engine. Freed on
                    // the next recording or cancel.
                    hideRetryButton();
                    refreshRetranscribeBtn();
                    micBtn.classList.add('show-check');
                    setTimeout(() => micBtn.classList.remove('show-check'), 1200);
                    log(`[render] transcribe OK | engine: ${currentSttConfig?.sttEngine || '?'}`);
            setStatus('done', '✓ COPIED');
                    setTimeout(hideStatus, 1600);
                    if (!currentSttConfig || currentSttConfig.playFinishSound !== false) playFinishChime();
                } else {
                    log(`[render] transcribe FAIL | code: ${result.code} | err: ${result.error || ''} | engine: ${currentSttConfig?.sttEngine || '?'}`);
                    const status = result.code === 'NO_SPEECH' ? t('status.NO_SPEECH') : (result.code === 'MODEL_UNAVAILABLE' ? 'MODEL UNAVAILABLE' : (result.code === 'NO_API_KEY' ? 'NO API KEY' : 'ERROR'));
                    setStatus('err', status);
                    if (isRetryableFailure(result.code)) {
                        showRetryButton();
                        setTimeout(hideStatus, 5000);
                    } else {
                        lastAudio = null;
                        setTimeout(hideStatus, 3000);
                    }
                    refreshRetranscribeBtn();
                }
            } catch (error) {
                if (sessionId !== recordingSessionId) return;
                isStartingRecording = false;
                micBtn.classList.remove('transcribing');
                micContainer.classList.remove('transcribing');
                setStatus('err', 'ERROR');
                if (lastAudio) showRetryButton();
                refreshRetranscribeBtn();
                setTimeout(hideStatus, 4000);
            }
        };

        mediaRecorder.start();
        isStartingRecording = false;
        isRecording = true;
        refreshRetranscribeBtn();
        recordStartTime = Date.now();
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
    const wasArmed = hasSpoken;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    isRecording = false;
    refreshRetranscribeBtn();
    document.body.classList.remove('is-recording');
    smoothedSpeechVolume = 0;
    speechFramesCount = 0;
    silenceStartTime = null;
    hasSpoken = false;
    noiseFloor = null;
    silenceAccumMs = 0;
    lastFrameTs = 0;
    vadDeadMicLogged = false;
    if (vadCount > 0 && !cancel) {
        const avg = (vadSum / vadCount).toFixed(1);
        const eff = currentSttConfig && typeof currentSttConfig.silenceThreshold === 'number'
            ? Math.max(6, Math.min(currentSttConfig.silenceThreshold, (noiseFloor === null ? 0 : noiseFloor) + 8))
            : '?';
        log(`[render] VAD summary | ${((Date.now() - recordStartTime) / 1000).toFixed(1)}s | smoothed min=${vadMin.toFixed(1)} max=${vadMax.toFixed(1)} avg=${avg} | effThresh≈${typeof eff === 'number' ? eff.toFixed(1) : eff} | armed=${wasArmed} | autoStopCfg=${!!(currentSttConfig && currentSttConfig.autoStopEnabled)} | ctx=${audioCtx ? audioCtx.state : 'closed'}`);
    }
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
    refreshRetranscribeBtn();
    stopRecordingCore(true);
}

// ---- App log (main writes it to %APPDATA%\VoiceToClipboard\app.log) ----
function log(msg) {
    try { window.api.rendererLog(String(msg)); } catch (e) { /* ignore */ }
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

async function retranscribeLast() {
    if (!lastAudio || isRecording || isStartingRecording) return;
    hideRetryButton();
    const audio = lastAudio;
    micBtn.classList.add('transcribing');
    micContainer.classList.add('transcribing');
    setStatus('busy', 'TRANSCRIBING');

    let result;
    try {
        const cfg = await window.api.getSttConfig();
        currentSttConfig = cfg;
        if (cfg.sttEngine === 'local') {
            if (!audio.pcm && audio.blob) {
                audio.pcm = await audioBlobTo16kHzFloat32(audio.blob);
                lastAudio.pcm = audio.pcm;
            }
            result = await window.api.transcribeAudio({
                engine: 'local',
                modelKey: cfg.localModelKey,
                pcm: audio.pcm.buffer,
                sampleRate: 16000,
                uiLanguage: uiLang
            });
        } else {
            result = await window.api.transcribeAudio({
                engine: 'gemini',
                arrayBuffer: await audio.blob.arrayBuffer(),
                mimeType: audio.mimeType,
                uiLanguage: uiLang
            });
        }
    } catch (error) {
        result = { success: false, code: 'TRANSCRIPTION_ERROR', error: String(error) };
    }

    micBtn.classList.remove('transcribing');
    micContainer.classList.remove('transcribing');

    if (result && result.success) {
        micBtn.classList.add('show-check');
        setTimeout(() => micBtn.classList.remove('show-check'), 1200);
        log(`[render] transcribe OK | engine: ${currentSttConfig?.sttEngine || '?'}`);
        setStatus('done', '✓ COPIED');
        setTimeout(hideStatus, 1600);
    } else {
        const code = result?.code || 'ERROR';
        log(`[render] transcribe FAIL(retry) | code: ${code} | err: ${result?.error || ''} | engine: ${currentSttConfig?.sttEngine || '?'}`);
        const status = code === 'NO_SPEECH' ? t('status.NO_SPEECH') : (code === 'MODEL_UNAVAILABLE' ? 'MODEL UNAVAILABLE' : (code === 'NO_API_KEY' ? 'NO API KEY' : (code === 'RATE_LIMITED' ? 'RATE LIMIT' : 'ERROR')));
        setStatus('err', status);
        if (isRetryableFailure(code)) {
            showRetryButton();
        } else {
            lastAudio = null;
        }
    }
    refreshRetranscribeBtn();
}

// The ↻ top-bar button re-runs the LAST transcription (even a successful one).
const retranscribeBtn = document.getElementById('retranscribe-btn');
function refreshRetranscribeBtn() {
    if (!retranscribeBtn) return;
    const has = !!(lastAudio && !isRecording && !isStartingRecording);
    retranscribeBtn.style.display = has ? 'flex' : 'none';
    if (has) refreshMouseIgnore();
}
if (retranscribeBtn) {
    retranscribeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        retranscribeBtn.style.display = 'none';
        await retranscribeLast();
    });
}

if (retryBtn) {
    retryBtn.addEventListener('click', () => retranscribeLast());
}

// UI language picker — applies instantly (offline), re-saves config.
if (uiLanguageSelect) {
    uiLanguageSelect.addEventListener('change', () => {
        setUiLanguage(uiLanguageSelect.value);
        autoSaveSettings();
    });
}

