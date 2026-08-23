// src/renderer/settings-ui.js
// Settings modal view controller: offline models dropdown, download pipeline, theme swatches, and history manager.

window.VTC = window.VTC || {};

(function () {
    const isSettingsWindow = new URLSearchParams(window.location.search).get('settings') === '1';

    // Real vector flags - Windows has no glyphs for regional-indicator emoji
    // (users literally see "US"/"CN" letters), so we render compact inline
    // SVGs instead. Simplified but recognizable at 18x13 px.
    const FLAG_SVGS = Object.freeze({
        US: '<svg viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#b22234"/><g fill="#fff"><rect y="1.08" width="20" height="1.08"/><rect y="3.23" width="20" height="1.08"/><rect y="5.38" width="20" height="1.08"/><rect y="7.54" width="20" height="1.08"/><rect y="9.69" width="20" height="1.08"/><rect y="11.85" width="20" height="1.08"/></g><rect width="9" height="7.54" fill="#3c3b6e"/><g fill="#fff"><circle cx="1.6" cy="1.5" r=".55"/><circle cx="3.7" cy="1.5" r=".55"/><circle cx="5.8" cy="1.5" r=".55"/><circle cx="7.4" cy="1.5" r=".55"/><circle cx="2.65" cy="2.9" r=".55"/><circle cx="4.75" cy="2.9" r=".55"/><circle cx="6.6" cy="2.9" r=".55"/><circle cx="1.6" cy="4.3" r=".55"/><circle cx="3.7" cy="4.3" r=".55"/><circle cx="5.8" cy="4.3" r=".55"/><circle cx="7.4" cy="4.3" r=".55"/><circle cx="2.65" cy="5.7" r=".55"/><circle cx="4.75" cy="5.7" r=".55"/><circle cx="6.6" cy="5.7" r=".55"/></g><rect width="20" height="14" fill="none" stroke="rgba(255,255,255,.28)" stroke-width=".6"/></svg>',
        ES: '<svg viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#c60b1e"/><rect y="3.5" width="20" height="7" fill="#ffc400"/><rect width="20" height="14" fill="none" stroke="rgba(255,255,255,.28)" stroke-width=".6"/></svg>',
        CN: '<svg viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#de2910"/><path d="M3.5 1.8 4.3 4h2.3l-1.85 1.4.7 2.25L3.5 6.3 1.55 7.65l.7-2.25L.4 4h2.3z" fill="#ffde00"/><g fill="#ffde00"><circle cx="7.6" cy="1.6" r=".62"/><circle cx="9" cy="3.1" r=".62"/><circle cx="9" cy="5" r=".62"/><circle cx="7.6" cy="6.5" r=".62"/></g><rect width="20" height="14" fill="none" stroke="rgba(255,255,255,.28)" stroke-width=".6"/></svg>'
    });
    const TIER_FLAG_CODES = Object.freeze({
        tiny: ['US'],
        mini: ['US', 'ES'],
        'zh-light': ['CN', 'US'],
        light: ['US', 'ES', 'CN'],
        big: ['US', 'ES', 'CN'],
        'zh-big': ['CN', 'US']
    });
    // Expected runtime speed per tier. Level drives a color-coded professional
    // bolt icon; label text comes from locales (models.speed.*).
    const TIER_SPEED = Object.freeze({
        tiny: { level: 3, key: 'models.speed.fastest' },
        mini: { level: 2, key: 'models.speed.fast' },
        'zh-light': { level: 2, key: 'models.speed.fast' },
        light: { level: 1, key: 'models.speed.balanced' },
        big: { level: 0, key: 'models.speed.thorough' },
        'zh-big': { level: 0, key: 'models.speed.thorough' }
    });
    const SPEED_BOLT_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6.8.5 1.8 6.9h2.9L4.9 11.5l5.3-6.6H7.2z"/></svg>';

    const MODEL_TIER_LABELS = Object.freeze({
        tiny: { name: 'Tiny' },
        mini: { name: 'Mini' },
        'zh-light': { name: 'Chinese + English (Light)' },
        light: { name: 'Light' },
        big: { name: 'Big' },
        'zh-big': { name: 'Chinese + English (Big)' }
    });

    // CRITICAL: mirrors stt/config.js WIDGET_STYLES. The renderer cannot
    // require() main-process modules, and this identifier was previously
    // undefined here, so the whole IIFE threw ReferenceError at the final
    // window.VTC.settings export — leaving EVERY window.VTC.settings.* call
    // in renderer.js dead (empty model dropdown, unsynced engine segment).
    const WIDGET_STYLES = Object.freeze(['crimson', 'ocean', 'aurora', 'terminal']);

    let currentWidgetStyle = 'crimson';
    // Legacy marker from an earlier pre-paint bootstrap script; nothing sets it
    // anymore, but keep the guard so a stray attribute can't force a repaint.
    let bootstrapStylePending = document.documentElement.getAttribute('data-bootstrap-widget-style');
    let refreshRequestId = 0;
    let lastFocusedBeforeSettings = null;
    let selectedEngine = 'local';
    let modelCatalog = [];
    let modelStatusRequestId = 0;
    let recommendedTier = 'light';
    let systemRamGB = null;
    let currentSttConfig = null;
    let activeDownloadKey = null;
    let downloadSpinnerEl = null;
    let autoSaveTimer = null;
    let settingsSaveQueue = Promise.resolve();
    let pasteKeyVal = ' ';
    // A ?settings=1 window has its modal pre-marked .active by renderer.js at
    // boot, before any config data arrives. openSettings() must still run its
    // first full refreshSettingsUi() exactly once for that activation, or
    // setEngine()/tier sync never happen and the offline model group stays
    // display:none until a manual engine re-click.
    let pendingExternalActivation = false;

    // DOM Elements
    const settingsModal = document.getElementById('settings-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const settingsBtn = document.getElementById('settings-btn');
    const closeBtn = document.getElementById('close-btn');
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
    const apiKeyInput = document.getElementById('api-key-input');
    const apiKeyNote = document.getElementById('api-key-note');
    const removeKeyBtn = document.getElementById('remove-key-btn');
    const uiLanguageSelect = document.getElementById('ui-language-select');
    const modelCard = document.getElementById('model-card');
    const modelCardName = document.getElementById('model-card-name');
    const modelCardMeta = document.getElementById('model-card-meta');
    const modelCardStatus = document.getElementById('model-card-status');
    const modelCardDesc = document.getElementById('model-card-desc');
    const modelCardLicense = document.getElementById('model-card-license');
    const modelCardAction = document.getElementById('model-card-action');
    const modelDownloadProgress = document.getElementById('model-download-progress');
    const modelDownloadStatus = document.getElementById('model-download-status');
    const modelDownloadSpinner = document.getElementById('model-download-spinner');
    const modelDownloadPct = document.getElementById('model-download-pct');
    const modelDownloadBar = document.getElementById('model-download-bar');
    const autoStopCheckbox = document.getElementById('auto-stop-checkbox');
    const autoStopOptions = document.getElementById('auto-stop-options');
    const autoStopSecondsSelect = document.getElementById('auto-stop-seconds');
    const silenceThresholdSlider = document.getElementById('silence-threshold-slider');
    const thresholdValueDisplay = document.getElementById('threshold-value-display');
    const idleFadeCheckbox = document.getElementById('idle-fade-checkbox');
    const idleFadeOptions = document.getElementById('idle-fade-options');
    const idleOpacitySlider = document.getElementById('idle-opacity-slider');
    const idleOpacityVal = document.getElementById('idle-opacity-val');
    const alwaysOnTopCheckbox = document.getElementById('always-on-top-checkbox');
    const finishSoundCheckbox = document.getElementById('finish-sound-checkbox');
    const saveRecordingsCheckbox = document.getElementById('save-recordings-checkbox');
    const openRecordingsBtn = document.getElementById('open-recordings-btn');
    const outputModeSelectEl = document.getElementById('output-mode-select');
    const autotypeMethodSelectEl = document.getElementById('autotype-method-select');
    const pasteKeyInputEl = document.getElementById('paste-key-input');
    const pressEnterCheckbox = document.getElementById('press-enter-checkbox');
    const alwaysCopyClipboardCheckbox = document.getElementById('always-copy-clipboard-checkbox');
    const historyEnabledCheckbox = document.getElementById('history-enabled-checkbox');
    const historyControlsGroup = document.getElementById('history-controls-group');
    const historySearchInput = document.getElementById('history-search-input');
    const historyExportBtn = document.getElementById('history-export-btn');
    const historyExportFormat = document.getElementById('history-export-format');
    const historyClearBtn = document.getElementById('history-clear-btn');
    const historyListContainer = document.getElementById('history-list-container');
    const ecoModeCheckbox = document.getElementById('eco-mode-checkbox');

    function formatDownloadSize(bytes) {
        const t = window.VTC?.i18n?.t || ((k) => k);
        if (!bytes) return t('model.sizePending');
        return t('model.mbDownload', { mb: Math.round(bytes / (1024 * 1024)) });
    }

    function modelForSelection() {
        const tier = localTierSelect?.value || 'light';
        return (Array.isArray(modelCatalog) ? modelCatalog : []).find(model => model.tier === tier) || null;
    }

    function getSelectedModelKey() {
        return modelForSelection()?.key || 'omni-multilingual';
    }

    function tierForLanguage(lang) {
        if (lang === 'zh') return 'zh-light';
        return (systemRamGB !== null && systemRamGB <= 4) ? 'tiny' : 'mini';
    }

    function langRecoModelKey() {
        const tr = tierForLanguage(window.VTC?.i18n?.uiLang || 'en');
        if (!tr) return null;
        const byTier = (modelCatalog || []).filter(m => m.tier === tr);
        return byTier.length ? byTier[0].key : null;
    }

    function applyModelRecommendation(snapshot) {
        const t = window.VTC?.i18n?.t || ((k) => k);
        const uiLang = window.VTC?.i18n?.uiLang || 'en';
        if (snapshot) {
            if (snapshot.recommendedTier) recommendedTier = snapshot.recommendedTier;
            if (typeof snapshot.systemRamGB === 'number') systemRamGB = snapshot.systemRamGB;
        }
        const langTier = tierForLanguage(uiLang);
        if (langTier) recommendedTier = langTier;
        const ramNote = document.getElementById('model-reco-ram');
        if (ramNote) ramNote.textContent = systemRamGB ? `(${systemRamGB} GB)` : '';

        const langNote = document.getElementById('model-lang-note');
        if (langNote) {
            const key = langRecoModelKey();
            if (key) {
                const model = (modelCatalog || []).find(m => m.key === key);
                const name = model ? t('model.' + key + '.name', null, model.name) : key;
                const langName = t('lang.' + uiLang, null, 'English');
                langNote.textContent = t('models.langNote', { lang: langName, model: name });
                langNote.style.display = 'block';
            } else {
                langNote.style.display = 'none';
            }
        }
        if (modelDropdownPanel) buildModelDropdown();
    }

    function dropdownSubLabel(model) {
        const t = window.VTC?.i18n?.t || ((k) => k);
        // Name lives on line 1; the sub line carries only facts.
        const size = formatDownloadSize(model.downloadBytes);
        const ram = String(model.ramEstimate || t('model.sizePending')).trim();
        return `${size} · ${ram}`;
    }

    function buildModelDropdown() {
        if (!modelDropdownPanel) return;
        const t = window.VTC?.i18n?.t || ((k) => k);
        modelDropdownPanel.replaceChildren();
        for (const model of modelCatalog) {
            const lbl = MODEL_TIER_LABELS[model.tier] || { name: model.name };
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'model-option';
            row.dataset.tier = model.tier;
            row.setAttribute('role', 'option');

            const main = document.createElement('span');
            main.className = 'mo-main';

            // Line 1: real vector flags + localized name (+ chips).
            const line = document.createElement('span');
            line.className = 'mo-line';
            const flags = document.createElement('span');
            flags.className = 'mo-flags';
            for (const code of (TIER_FLAG_CODES[model.tier] || [])) {
                const f = document.createElement('span');
                f.className = 'mo-flag';
                f.innerHTML = FLAG_SVGS[code] || '';
                flags.appendChild(f);
            }
            const name = document.createElement('span');
            name.className = 'mo-name';
            name.textContent = t('models.tier.' + model.tier, null, lbl.name);
            if (model.tier === recommendedTier) {
                const chip = document.createElement('span');
                chip.className = 'mo-chip';
                chip.textContent = t('models.recommended', null, '⭐ Recommended');
                name.appendChild(chip);
            }
            line.append(flags, name);

            // Line 2: size · RAM estimate.
            const sub = document.createElement('span');
            sub.className = 'mo-sub';
            sub.textContent = dropdownSubLabel(model);
            main.append(line, sub);

            // Right side: color-coded speed indicator, then installed state.
            const end = document.createElement('span');
            end.className = 'mo-end';
            const speed = TIER_SPEED[model.tier];
            if (speed) {
                const sp = document.createElement('span');
                sp.className = `mo-speed mo-speed-${speed.level}`;
                sp.innerHTML = SPEED_BOLT_SVG;
                const spTxt = document.createElement('span');
                spTxt.textContent = t(speed.key, null, '');
                sp.appendChild(spTxt);
                sp.title = t(speed.key, null, '');
                end.appendChild(sp);
            }
            if (model.installed) {
                const inst = document.createElement('span');
                inst.className = 'mo-installed';
                inst.title = t('model.installed', null, 'Installed');
                const instSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                instSvg.setAttribute('viewBox', '0 0 12 12');
                const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                pathEl.setAttribute('d', 'M2 6.4 4.8 9.2 10 3.4');
                pathEl.setAttribute('fill', 'none');
                pathEl.setAttribute('stroke', 'currentColor');
                pathEl.setAttribute('stroke-width', '1.8');
                pathEl.setAttribute('stroke-linecap', 'round');
                pathEl.setAttribute('stroke-linejoin', 'round');
                instSvg.appendChild(pathEl);
                inst.appendChild(instSvg);
                const instTxt = document.createElement('span');
                instTxt.textContent = t('model.installed', null, 'Installed');
                inst.appendChild(instTxt);
                end.appendChild(inst);
            }

            // Elite quality family: Big and Chinese-Big share ONE identical
            // gold badge so they read as a single top-tier group.
            if (model.tier === 'big' || model.tier === 'zh-big') {
                const best = document.createElement('span');
                best.className = 'mo-chip mo-chip-best';
                best.textContent = t('models.bestQuality', null, 'Best quality');
                end.appendChild(best);
            }

            const check = document.createElement('span');
            check.className = 'mo-check';
            check.textContent = '✓';

            row.append(main, end, check);
            if (model.installed) row.classList.add('is-installed');
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
        const t = window.VTC?.i18n?.t || ((k) => k);
        const lbl = MODEL_TIER_LABELS[tier] || { name: model?.name || 'Light' };
        modelDropdownCurrent.textContent = t('models.tier.' + tier, null, lbl.name);
        if (modelDropdownChip) modelDropdownChip.style.display = tier === recommendedTier ? 'inline-flex' : 'none';
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
            // Self-heal: an empty panel means the catalog fetch failed or the
            // dropdown was built before the catalog arrived; rebuild (or
            // refetch) so opening it can never show zero options.
            if (!modelDropdownPanel?.childElementCount) {
                if (modelCatalog.length) buildModelDropdown();
                else loadModelCatalog().catch(() => {});
            }
            const open = modelDropdownPanel.style.display !== 'block';
            modelDropdownPanel.style.display = open ? 'block' : 'none';
            modelDropdown.classList.toggle('open', open);
            modelDropdownBtn.setAttribute('aria-expanded', String(open));
            if (open) updateDropdownCurrent();
        });
    }

    document.addEventListener('click', (e) => {
        if (modelDropdown && modelDropdown.classList.contains('open') && !modelDropdown.contains(e.target)) {
            closeModelDropdown();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modelDropdown?.classList.contains('open')) {
            closeModelDropdown();
            e.stopImmediatePropagation();
            e.preventDefault();
            return;
        }
    });

    async function loadModelCatalog() {
        // Only replace the catalog on a valid array: a transient IPC failure
        // must not wipe the dropdown into an unfixable empty state.
        const catalog = await window.api?.getModelCatalog();
        if (Array.isArray(catalog)) modelCatalog = catalog;
        renderModelCard();
        buildModelDropdown();
    }

    function setEngine(engine) {
        selectedEngine = engine;
        const isGemini = engine === 'gemini';
        if (engineBtnGemini) {
            engineBtnGemini.classList.toggle('active', isGemini);
            engineBtnGemini.setAttribute('aria-pressed', String(isGemini));
        }
        if (engineBtnLocal) {
            engineBtnLocal.classList.toggle('active', !isGemini);
            engineBtnLocal.setAttribute('aria-pressed', String(!isGemini));
        }
        if (localModelGroup) localModelGroup.style.display = isGemini ? 'none' : 'flex';
        const ecoGroup = document.getElementById('eco-mode-group');
        if (ecoGroup) ecoGroup.style.display = isGemini ? 'none' : 'flex';
        if (geminiKeyGroup) {
            const hasEnv = removeKeyBtn && removeKeyBtn.disabled && removeKeyBtn.title;
            geminiKeyGroup.style.display = (isGemini && !hasEnv) ? 'flex' : 'none';
        }
        updateLocalModelUi();
    }

    function renderModelCard() {
        if (!modelCard) return;
        const t = window.VTC?.i18n?.t || ((k) => k);
        const model = modelForSelection();
        if (!model) {
            modelCard.style.display = 'none';
            return;
        }
        modelCard.style.display = 'block';
        if (modelCardName) modelCardName.textContent = t('model.' + model.key + '.name', null, model.name);
        const backendLabels = {
            moonshine: 'Moonshine',
            whisper: 'Whisper',
            'nemo-transducer': 'FastConformer Transducer',
            'sense-voice': 'SenseVoice',
            'fire-red-asr-ctc': 'FireRedASR2'
        };
        const backendLabel = backendLabels[model.backend] || model.name;
        if (modelCardMeta) {
            modelCardMeta.textContent = t('model.cardMeta', { backend: backendLabel, lang: t('model.language.auto'), size: formatDownloadSize(model.downloadBytes), ram: model.ramEstimate || '' });

        }
        if (modelCardDesc) modelCardDesc.textContent = t('model.' + model.key + '.desc', null, model.description);
        if (modelCardLicense) modelCardLicense.textContent = t('model.licensePrefix', { license: model.license });
        if (modelCardStatus) {
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
        }
        renderModelCardAction(model);
    }

    function renderModelCardAction(model) {
        if (!modelCardAction) return;
        const t = window.VTC?.i18n?.t || ((k) => k);
        modelCardAction.replaceChildren();
        if (!model.verified) {
            const note = document.createElement('div');
            note.style.cssText = 'font-size: 10px; color: var(--text-dim); line-height: 1.4;';
            note.textContent = model.unavailableReason || t('model.compatPending');
            modelCardAction.append(note);
            return;
        }
        if (activeDownloadKey === model.key) {
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn-secondary';
            cancelBtn.textContent = t('model.cancelDownload');
            cancelBtn.style.cssText = 'padding: 6px 12px; font-size: 10.5px; border-color: rgba(230, 57, 70, 0.4); color: #ff8f9d; cursor: pointer;';
            cancelBtn.addEventListener('click', async () => {
                cancelBtn.disabled = true;
                cancelBtn.textContent = t('model.downloading');
                await window.api?.cancelLocalModelDownload(model.key).catch(() => {});
            });
            modelCardAction.append(cancelBtn);
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
                await window.api?.removeLocalModel(model.key);
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
        const t = window.VTC?.i18n?.t || ((k) => k);
        if (/base256|checksum|archive|tar|bzip/i.test(msg)) return t('model.errorArchive');
        if (/timed out|timeout/i.test(msg)) return t('model.errorTimeout');
        if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|socket|getaddrinfo/i.test(msg)) return t('model.errorNetwork');
        if (/HTTP \d{3}/i.test(msg)) return t('model.errorServer');
        if (/missing required files/i.test(msg)) return t('model.errorIncomplete');
        return msg;
    }

    function addDownloadSpinner() {
        if (modelDownloadSpinner) modelDownloadSpinner.style.display = 'inline-block';
    }

    function removeDownloadSpinner() {
        if (modelDownloadSpinner) modelDownloadSpinner.style.display = 'none';
    }

    async function startModelDownload(modelKey, triggerBtn) {
        const t = window.VTC?.i18n?.t || ((k) => k);
        removeDownloadSpinner();
        if (activeDownloadKey) return;
        activeDownloadKey = modelKey;
        const downloadStartedAt = Date.now();

        if (modelDownloadProgress) modelDownloadProgress.style.display = 'block';
        if (modelDownloadStatus) modelDownloadStatus.textContent = t('model.downloading');
        if (modelDownloadPct) modelDownloadPct.textContent = '0%';
        if (modelDownloadBar) {
            modelDownloadBar.style.width = '0%';
            modelDownloadBar.classList.add('extracting');
        }
        addDownloadSpinner();
        window.VTC?.recording?.setStatus('busy', 'DOWNLOADING');
        if (triggerBtn) triggerBtn.disabled = true;
        if (modelCardStatus) {
            modelCardStatus.textContent = '⬇ ' + t('model.downloading');
            modelCardStatus.className = 'status-pill download-needed';
        }
        renderModelCardAction(modelForSelection());

        let downloadStats = {};
        const progressListener = (data) => {
            if (!data) return;
            if (data.status === 'initiate') {
                downloadStats = {};
                if (modelDownloadBar) {
                    modelDownloadBar.classList.add('extracting');
                    modelDownloadBar.style.width = '100%';
                }
                addDownloadSpinner();
                window.VTC?.recording?.setStatus('busy', 'DOWNLOADING');
                if (modelDownloadPct) modelDownloadPct.textContent = '0%';
                if (modelDownloadStatus) modelDownloadStatus.textContent = t('model.downloading');
                return;
            }
            if (data.status === 'progress' && data.file && typeof data.loaded === 'number' && data.total) {
                downloadStats[data.file] = { loaded: data.loaded, total: data.total };
                let totalLoaded = 0;
                let totalSize = 0;
                for (const key in downloadStats) {
                    totalLoaded += downloadStats[key].loaded;
                    totalSize += downloadStats[key].total;
                }
                if (totalSize > 0) {
                    const pct = Math.min(100, Math.round((totalLoaded / totalSize) * 100));
                    if (modelDownloadBar) {
                        modelDownloadBar.classList.remove('extracting');
                        modelDownloadBar.style.width = `${pct}%`;
                    }
                    addDownloadSpinner();
                    if (modelDownloadPct) modelDownloadPct.textContent = `${pct}%`;
                    let statusText = t('model.downloading2', { a: (totalLoaded / 1048576).toFixed(1), b: (totalSize / 1048576).toFixed(1) });
                    const elapsedSec = (Date.now() - downloadStartedAt) / 1000;
                    const speedMBps = elapsedSec > 1 ? (totalLoaded / 1048576) / elapsedSec : 0;
                    if (speedMBps > 0) {
                        statusText += t('model.speed', { s: speedMBps.toFixed(1) });
                        const remainingSec = speedMBps > 0 ? ((totalSize - totalLoaded) / 1048576) / speedMBps : 0;
                        if (remainingSec >= 90) {
                            statusText += t('model.etaMin', { m: Math.max(1, Math.round(remainingSec / 60)) });
                        } else if (remainingSec >= 5) {
                            statusText += t('model.etaSec', { s: Math.round(remainingSec) });
                        }
                    }
                    if (modelDownloadStatus) modelDownloadStatus.textContent = statusText;
                }
            } else if (data.status === 'extracting') {
                if (modelDownloadStatus) modelDownloadStatus.textContent = t('model.extracting');
                addDownloadSpinner();
                window.VTC?.recording?.setStatus('busy', 'INSTALLING');
                if (modelDownloadBar) {
                    modelDownloadBar.classList.add('extracting');
                    modelDownloadBar.style.width = '100%';
                }
                if (modelDownloadPct) modelDownloadPct.textContent = '…';
            } else if (data.status === 'verified') {
                if (modelDownloadBar) modelDownloadBar.classList.remove('extracting');
                removeDownloadSpinner();
                if (modelDownloadStatus) modelDownloadStatus.textContent = t('model.verified');
            }
        };

        window.api?.on('download-progress', progressListener);
        const res = await window.api?.downloadLocalModel(modelKey);
        window.api?.removeListener('download-progress', progressListener);
        activeDownloadKey = null;

        if (res?.success) {
            await window.api?.saveSttConfig({
                sttEngine: 'local',
                localTier: localTierSelect?.value || 'light',
                autoStopEnabled: autoStopCheckbox?.checked || false,
                autoStopSeconds: parseFloat(autoStopSecondsSelect?.value || '3.5'),
                silenceThreshold: parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12,
                ecoMode: ecoModeCheckbox ? ecoModeCheckbox.checked : true,
                outputMode: outputModeSelectEl ? outputModeSelectEl.value : (currentSttConfig?.outputMode || 'clipboard'),
                autotypeMethod: autotypeMethodSelectEl ? autotypeMethodSelectEl.value : (currentSttConfig?.autotypeMethod || 'unicode'),
                pressEnter: pressEnterCheckbox ? pressEnterCheckbox.checked : false,
                alwaysCopyToClipboard: alwaysCopyClipboardCheckbox ? alwaysCopyClipboardCheckbox.checked : true,
                historyEnabled: historyEnabledCheckbox ? historyEnabledCheckbox.checked : false,
                saveRecordings: saveRecordingsCheckbox ? saveRecordingsCheckbox.checked : false
            });
            removeDownloadSpinner();
            if (modelDownloadBar) {
                modelDownloadBar.classList.remove('extracting');
                modelDownloadBar.style.width = '100%';
            }
            if (modelDownloadStatus) modelDownloadStatus.textContent = t('model.installed');
            if (modelDownloadPct) modelDownloadPct.textContent = '100%';
            window.VTC?.recording?.setStatus('done', '✓ MODEL READY');
            setTimeout(() => window.VTC?.recording?.hideStatus(), 2500);

            await loadModelCatalog();
            await checkModelStatus();
            updateLocalModelUi();
            buildModelDropdown();
            renderModelCard();
            setTimeout(() => {
                if (modelDownloadProgress) modelDownloadProgress.style.display = 'none';
                if (modelDownloadBar) modelDownloadBar.style.width = '0%';
            }, 1600);
        } else {
            removeDownloadSpinner();
            window.VTC?.recording?.hideStatus();
            if (modelDownloadBar) {
                modelDownloadBar.classList.remove('extracting');
                modelDownloadBar.style.width = '0%';
            }
            if (res?.code === 'CANCELLED' || res?.error === 'Download cancelled.') {
                if (modelDownloadStatus) modelDownloadStatus.textContent = t('model.downloadCancelled');
                if (modelDownloadPct) modelDownloadPct.textContent = '—';
                if (modelCardStatus) {
                    modelCardStatus.textContent = '⚠️ ' + t('model.pending');
                    modelCardStatus.className = 'status-pill download-needed';
                }
                renderModelCardAction(modelForSelection());
                setTimeout(() => {
                    if (!activeDownloadKey && modelDownloadProgress) {
                        modelDownloadProgress.style.display = 'none';
                    }
                }, 1400);
            } else {
                if (modelDownloadStatus) modelDownloadStatus.textContent = t('model.downloadFailed', { err: friendlyDownloadError(res?.error) });
                if (modelDownloadPct) modelDownloadPct.textContent = '—';
                if (modelCardStatus) {
                    modelCardStatus.textContent = t('model.retry');
                    modelCardStatus.className = 'status-pill download-needed';
                }
                renderModelCardAction(modelForSelection());
            }
        }
    }

    function updateLocalModelUi() {
        renderModelCard();
    }

    async function checkModelStatus() {
        const requestId = ++modelStatusRequestId;
        const model = modelForSelection();
        const modelKey = model?.key || getSelectedModelKey();
        updateLocalModelUi();
        const res = await window.api?.checkModelDownloaded(modelKey);
        if (requestId !== modelStatusRequestId) return;
        const catalogModel = modelCatalog.find(m => m.key === modelKey);
        if (catalogModel && res) catalogModel.installed = !!res.downloaded;
        renderModelCard();
    }

    function applyIdleFadeState(enabled, opacityPct) {
        const decimalOpacity = (opacityPct / 100).toFixed(2);
        document.documentElement.style.setProperty('--idle-opacity', decimalOpacity);
        document.body.classList.toggle('idle-fade-active', !!enabled);
    }

    function applyWidgetStyle(style) {
        const s = WIDGET_STYLES.includes(style) ? style : 'crimson';
        // THEME DATA FLOW (regressed twice — read before touching):
        // 1. initializeRenderer() fetches getSttConfig() and calls
        //    applyAppearanceSnapshot(), which lands here with the config style.
        // 2. The attribute is only written when it actually changes.
        // Re-setting the attribute (and toggling .theme-switching) restarts CSS
        // animations — the visible post-paint "morph". So when the attribute
        // already matches we skip the DOM write entirely; the painted value
        // wins on any disagreement. Real style
        // changes (user clicks a swatch) still take the full path below.
        if (document.documentElement.getAttribute('data-widget-style') === s) {
            const picker = document.getElementById('style-picker');
            if (picker) markActiveSwatch(picker, s);
            return;
        }
        document.documentElement.classList.add('theme-switching');
        document.documentElement.setAttribute('data-widget-style', s);
        requestAnimationFrame(() => document.documentElement.classList.remove('theme-switching'));
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

    function setWidgetStyle(style, { save = true } = {}) {
        const s = WIDGET_STYLES.includes(style) ? style : 'crimson';
        bootstrapStylePending = null;
        document.documentElement.removeAttribute('data-bootstrap-widget-style');
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
        markActiveSwatch(picker, currentWidgetStyle);
    }

    function applyAppearanceSnapshot(snapshot) {
        if (!snapshot) return;
        const idleOpacity = typeof snapshot.idleOpacity === 'number' ? Math.round(snapshot.idleOpacity * 100) : 65;
        applyIdleFadeState(snapshot.idleFadeEnabled, idleOpacity);
        if (WIDGET_STYLES.includes(bootstrapStylePending)) {
            // Theme bootstrap ran before first paint. Treat it as the startup
            // source of truth even if a queued config write makes this later
            // snapshot differ; otherwise the widget visibly morphs at boot.
            currentWidgetStyle = bootstrapStylePending;
            const picker = document.getElementById('style-picker');
            if (picker) markActiveSwatch(picker, currentWidgetStyle);
            bootstrapStylePending = null;
            document.documentElement.removeAttribute('data-bootstrap-widget-style');
            return;
        }
        if (typeof snapshot.widgetStyle === 'string') {
            currentWidgetStyle = WIDGET_STYLES.includes(snapshot.widgetStyle) ? snapshot.widgetStyle : 'crimson';
            applyWidgetStyle(currentWidgetStyle);
        }
    }

    function updateOutputModeVisibility() {
        const outputModeSelect = document.getElementById('output-mode-select');
        const pasteKeyRow = document.getElementById('paste-key-row');
        const autotypeMethodRow = document.getElementById('autotype-method-row');
        const autotypeNote = document.getElementById('autotype-note');
        const pressEnterRow = document.getElementById('press-enter-row');
        const pressEnterNote = document.getElementById('press-enter-note');
        const val = outputModeSelect ? outputModeSelect.value : 'clipboard';

        if (pasteKeyRow) pasteKeyRow.style.display = val === 'bubble' ? 'flex' : 'none';
        if (autotypeMethodRow) autotypeMethodRow.style.display = val === 'autotype' ? 'flex' : 'none';
        if (autotypeNote) autotypeNote.style.display = val === 'autotype' ? 'inline-flex' : 'none';
        if (pressEnterRow) pressEnterRow.style.display = val !== 'clipboard' ? 'flex' : 'none';
        if (pressEnterNote) pressEnterNote.style.display = val !== 'clipboard' ? 'inline-flex' : 'none';
    }

    let historyRenderSeq = 0;

    async function renderHistoryList(query) {
        if (!historyListContainer) return;
        if (typeof query !== 'string') query = historySearchInput ? historySearchInput.value : '';
        const t = window.VTC?.i18n?.t || ((k) => k);
        const requestSeq = ++historyRenderSeq;
        try {
            const items = await window.api?.history.list(query);
            if (requestSeq !== historyRenderSeq) return; // a newer query superseded this one
            historyListContainer.replaceChildren();

            if (!items || items.length === 0) {
                const emptyEl = document.createElement('div');
                emptyEl.className = 'history-empty-msg';
                emptyEl.textContent = t(query && query.trim() ? 'history.emptySearch' : 'history.empty', query && query.trim() ? { q: query.trim() } : null);
                historyListContainer.appendChild(emptyEl);
                return;
            }

            items.forEach(item => {
                const card = document.createElement('div');
                card.className = 'history-card';

                const header = document.createElement('div');
                header.className = 'history-card-header';

                const engineBadge = document.createElement('span');
                engineBadge.className = `history-engine-badge ${item.engine === 'gemini' ? 'gemini' : 'local'}`;
                engineBadge.textContent = item.engine === 'gemini' ? t('engine.gemini') : t('engine.offline');

                const metaText = document.createElement('span');
                metaText.className = 'history-card-meta';
                const dateStr = item.ts ? new Date(item.ts).toLocaleString() : '';
                const modelStr = item.model || '';
                const charsStr = item.chars ? t('history.chars', { n: item.chars }) : '';
                const durStr = item.durationMs ? `${(item.durationMs / 1000).toFixed(1)}s` : '';
                metaText.textContent = [dateStr, modelStr, charsStr, durStr].filter(Boolean).join(' · ');

                header.append(engineBadge, metaText);

                const textEl = document.createElement('div');
                textEl.className = 'history-card-text';
                textEl.textContent = item.text || '';

                const actions = document.createElement('div');
                actions.className = 'history-card-actions';

                const copyBtn = document.createElement('button');
                copyBtn.type = 'button';
                copyBtn.className = 'btn-secondary history-act-btn';
                copyBtn.textContent = t('history.copy');
                copyBtn.addEventListener('click', async () => {
                    await navigator.clipboard.writeText(item.text || '');
                    copyBtn.textContent = t('history.copied');
                    setTimeout(() => { copyBtn.textContent = t('history.copy'); }, 1500);
                });

                const pasteBtn = document.createElement('button');
                pasteBtn.type = 'button';
                pasteBtn.className = 'btn-secondary history-act-btn';
                pasteBtn.textContent = t('history.paste');
                pasteBtn.addEventListener('click', async () => {
                    if (window.api && window.api.pasteText) {
                        await window.api.pasteText(item.text || '');
                    } else {
                        await navigator.clipboard.writeText(item.text || '');
                    }
                });

                const deleteBtn = document.createElement('button');
                deleteBtn.type = 'button';
                deleteBtn.className = 'btn-remove history-act-btn';
                deleteBtn.style.display = 'inline-block';
                deleteBtn.textContent = t('history.delete');
                deleteBtn.addEventListener('click', () => {
                    card.classList.add('removing');
                    setTimeout(async () => {
                        await window.api?.history.delete(item.id);
                        renderHistoryList(historySearchInput ? historySearchInput.value : '');
                    }, 180);
                });

                actions.append(copyBtn, pasteBtn, deleteBtn);
                card.append(header, textEl, actions);
                historyListContainer.appendChild(card);
            });
        } catch (e) {
            console.warn('[render] Error loading history:', e);
        }
    }

    // Points at the latest debounced save payload so an imminent close can
    // flush it synchronously instead of waiting out the 150ms timer.
    let runQueuedSettingsSave = null;

    function flushPendingSettingsSave() {
        if (!autoSaveTimer) return;
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
        const runNow = runQueuedSettingsSave;
        runQueuedSettingsSave = null;
        if (runNow) {
            try { settingsSaveQueue = settingsSaveQueue.then(runNow, runNow).catch(e => console.error('Settings save failed:', e)); } catch (e) {}
        }
    }

    function autoSaveSettings() {
        clearTimeout(autoSaveTimer);
        const save = async () => {
                const engine = selectedEngine;
                const localTier = localTierSelect?.value || currentSttConfig?.localTier || 'light';
                const autoStopEnabled = autoStopCheckbox?.checked || false;
                const autoStopSeconds = parseFloat(autoStopSecondsSelect?.value || '3.5') || 3.5;
                const silenceThreshold = parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12;
                const ecoMode = ecoModeCheckbox ? ecoModeCheckbox.checked : true;
                const playFinishSound = finishSoundCheckbox ? finishSoundCheckbox.checked : true;
                const alwaysOnTop = alwaysOnTopCheckbox ? alwaysOnTopCheckbox.checked : true;
                const idleFadeEnabled = idleFadeCheckbox ? idleFadeCheckbox.checked : false;
                const idleOpacityPct = parseInt(idleOpacitySlider ? idleOpacitySlider.value : 60) || 60;
                const idleOpacity = idleOpacityPct / 100;

                if (apiKeyInput && apiKeyInput.value) {
                    const keyLines = apiKeyInput.value.split('\n').map(s => s.trim()).filter(Boolean);
                    if (keyLines.length) {
                        await window.api?.saveApiKey(keyLines);
                        apiKeyInput.value = '';
                        await checkApiKeyStatus();
                    }
                }

                const outputModeVal = outputModeSelectEl ? outputModeSelectEl.value : (currentSttConfig?.outputMode || 'clipboard');
                const autotypeMethodVal = autotypeMethodSelectEl ? autotypeMethodSelectEl.value : (currentSttConfig?.autotypeMethod || 'unicode');
                const micDeviceId = window.VTC?.audio?.micDeviceId || '';
                const micDeviceLabel = window.VTC?.audio?.micDeviceLabel || '';

                const saved = await window.api?.saveSttConfig({
                    sttEngine: engine,
                    uiLanguage: uiLanguageSelect ? uiLanguageSelect.value : (window.VTC?.i18n?.uiLang || 'en'),
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
                    outputMode: outputModeVal,
                    autotypeMethod: autotypeMethodVal,
                    pressEnter: pressEnterCheckbox ? pressEnterCheckbox.checked : false,
                    alwaysCopyToClipboard: alwaysCopyClipboardCheckbox ? alwaysCopyClipboardCheckbox.checked : true,
                    spacePaste: outputModeVal !== 'clipboard',
                    pasteStyle: outputModeVal === 'toast' ? 'toast' : 'bubble',
                    pasteKey: pasteKeyVal,
                    widgetStyle: currentWidgetStyle,
                    saveRecordings: saveRecordingsCheckbox ? saveRecordingsCheckbox.checked : false,
                    micDeviceId,
                    micDeviceLabel,
                    historyEnabled: historyEnabledCheckbox ? historyEnabledCheckbox.checked : false
                });
                if (!saved?.success) return;

                currentSttConfig = {
                    sttEngine: engine,
                    outputMode: outputModeVal,
                    autotypeMethod: autotypeMethodVal,
                    pressEnter: pressEnterCheckbox ? pressEnterCheckbox.checked : false,
                    alwaysCopyToClipboard: alwaysCopyClipboardCheckbox ? alwaysCopyClipboardCheckbox.checked : true,
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
        runQueuedSettingsSave = save;
        autoSaveTimer = setTimeout(() => {
            settingsSaveQueue = settingsSaveQueue.then(save, save).catch(error => console.error('Settings save failed:', error));
        }, 150);
    }

    async function checkApiKeyStatus() {
        const sttConfig = await window.api?.getSttConfig();
        currentSttConfig = sttConfig;
        const tr = window.VTC?.i18n?.tr || ((m) => m);
        const statusBadge = document.getElementById('status-badge');
        if (sttConfig?.sttEngine === 'gemini') {
            const status = await window.api?.getApiKeyStatus();
            if (!status?.hasKey) {
                window.VTC?.recording?.setStatus('err', 'API KEY REQUIRED');
            } else if (statusBadge && (statusBadge.textContent.includes(tr('API KEY REQUIRED')) || statusBadge.textContent.includes(tr('NO API KEY')))) {
                window.VTC?.recording?.hideStatus();
            }
            const cooldowns = await window.api?.getGeminiCooldowns?.() || {};
            const keyNote = document.getElementById('api-key-note');
            const activeKeys = Number(cooldowns.keysActive) || 0;
            const activeModels = Number(cooldowns.modelsActive) || 0;
            if (keyNote && (activeKeys > 0 || activeModels > 0)) {
                const t = window.VTC?.i18n?.t || ((k, v) => k);
                keyNote.textContent = t('gemini.cooldownState', {
                    keys: activeKeys,
                    models: activeModels,
                    s: cooldowns.nextRetryInSec || cooldowns.retryInSec || 0
                });
            }
        } else {
            if (!sttConfig?.isDownloaded) {
                window.VTC?.recording?.setStatus('err', 'DOWNLOAD MODEL');
            } else if (statusBadge && (statusBadge.textContent.includes(tr('DOWNLOAD MODEL')) || statusBadge.textContent.includes(tr('MODEL NOT DOWNLOADED')) || statusBadge.textContent.includes(tr('MODEL UNAVAILABLE')))) {
                window.VTC?.recording?.setStatus('done', '✓ MODEL READY');
                setTimeout(() => window.VTC?.recording?.hideStatus(), 2000);
            }
        }
    }

    async function refreshSettingsUi(snapshot = null) {
        const requestId = ++refreshRequestId;
        const t = window.VTC?.i18n?.t || ((k) => k);
        // Re-read GEMINI_API_KEY from the live Windows environment first so a
        // key changed in System Properties while the app runs is reflected in
        // the status badge and the next Gemini transcription.
        if (window.api?.refreshEnvApiKey) {
            await window.api.refreshEnvApiKey().catch(() => {});
        }
        if (!modelCatalog || !modelCatalog.length) {
            await loadModelCatalog().catch(() => {});
        }
        // One failed IPC round-trip must not abort the whole refresh before
        // setEngine()/tier sync run; fall through with what we have.
        const sttConfig = snapshot || await window.api?.getSttConfig()?.catch(() => null) || currentSttConfig || {};
        if (requestId !== refreshRequestId) return;
        applyAppearanceSnapshot(sttConfig);
        currentSttConfig = sttConfig;
        window.VTC?.i18n?.applyI18n(sttConfig?.uiLanguage || 'en');
        if (uiLanguageSelect) uiLanguageSelect.value = sttConfig?.uiLanguage || 'en';
        const cachePath = document.getElementById('model-cache-path');
        if (cachePath && sttConfig?.modelCachePath) cachePath.textContent = `${t('models.cachePath')} (${sttConfig.modelCachePath})`;
        const recPathDisplay = document.getElementById('recordings-path-display');
        if (recPathDisplay && sttConfig?.recordingsPath) recPathDisplay.textContent = sttConfig.recordingsPath;
        const apiStatus = await window.api?.getApiKeyStatus()?.catch(() => null);
        if (requestId !== refreshRequestId) return;

        await window.VTC?.interaction?.loadHotkey();
        if (requestId !== refreshRequestId) return;
        applyModelRecommendation(sttConfig);
        setEngine(sttConfig?.sttEngine || 'local');
        if (localTierSelect) localTierSelect.value = sttConfig?.localTier || recommendedTier;
        updateDropdownCurrent();
        updateLocalModelUi();
        if (finishSoundCheckbox) finishSoundCheckbox.checked = sttConfig?.playFinishSound !== false;

        if (autoStopCheckbox) autoStopCheckbox.checked = !!sttConfig?.autoStopEnabled;
        if (outputModeSelectEl) {
            let mode = sttConfig?.outputMode;
            if (!mode) {
                if (sttConfig?.spacePaste === false) mode = 'clipboard';
                else if (sttConfig?.pasteStyle === 'toast') mode = 'toast';
                else if (sttConfig?.spacePaste === true || sttConfig?.pasteStyle === 'bubble') mode = 'bubble';
                else mode = 'clipboard';
            }
            outputModeSelectEl.value = mode;
        }
        if (autotypeMethodSelectEl) {
            autotypeMethodSelectEl.value = sttConfig?.autotypeMethod || 'unicode';
        }
        updateOutputModeVisibility();
        if (pasteKeyInputEl) {
            const rawKey = (typeof sttConfig?.pasteKey === 'string' && sttConfig.pasteKey) ? sttConfig.pasteKey : ' ';
            pasteKeyVal = rawKey;
            pasteKeyInputEl.value = rawKey === ' ' ? 'SPACE' : rawKey.toUpperCase();
        }
        if (pressEnterCheckbox) {
            pressEnterCheckbox.checked = !!sttConfig?.pressEnter;
        }
        if (alwaysCopyClipboardCheckbox) {
            alwaysCopyClipboardCheckbox.checked = sttConfig?.alwaysCopyToClipboard !== false;
        }
        if (autoStopSecondsSelect) autoStopSecondsSelect.value = (sttConfig?.autoStopSeconds || 3.5).toFixed(1);
        if (autoStopOptions) autoStopOptions.style.display = autoStopCheckbox?.checked ? 'flex' : 'none';
        if (document.getElementById('settings-modal')?.classList.contains('active')) {
            window.VTC?.vad?.startSettingsMicPreview?.();
        }

        const silenceThreshold = typeof sttConfig?.silenceThreshold === 'number' ? sttConfig.silenceThreshold : 12;
        if (silenceThresholdSlider) silenceThresholdSlider.value = silenceThreshold;
        if (thresholdValueDisplay) thresholdValueDisplay.textContent = silenceThreshold;
        window.VTC?.vad?.updateMeterUI(window.VTC?.vad?.smoothedSpeechVolume || 0, silenceThreshold);

        if (ecoModeCheckbox) ecoModeCheckbox.checked = !!sttConfig?.ecoMode;
        if (alwaysOnTopCheckbox) alwaysOnTopCheckbox.checked = sttConfig?.alwaysOnTop !== false;

        const idleFadeEnabled = !!sttConfig?.idleFadeEnabled;
        const idleOpacity = typeof sttConfig?.idleOpacity === 'number' ? Math.round(sttConfig.idleOpacity * 100) : 65;
        if (idleFadeCheckbox) idleFadeCheckbox.checked = idleFadeEnabled;
        if (idleFadeOptions) idleFadeOptions.style.display = idleFadeEnabled ? 'flex' : 'none';
        if (idleOpacitySlider) idleOpacitySlider.value = idleOpacity;
        if (idleOpacityVal) idleOpacityVal.textContent = `${idleOpacity}%`;

        const recordingsFolderDetails = document.getElementById('recordings-folder-details');
        if (saveRecordingsCheckbox) {
            const isSaveEnabled = !!sttConfig?.saveRecordings;
            saveRecordingsCheckbox.checked = isSaveEnabled;
            if (recordingsFolderDetails) {
                recordingsFolderDetails.style.display = isSaveEnabled ? 'block' : 'none';
            }
        }

        if (apiKeyInput) apiKeyInput.value = '';
        if (window.VTC?.audio) {
            window.VTC.audio.micDeviceId = sttConfig?.micDeviceId || '';
            window.VTC.audio.micDeviceLabel = sttConfig?.micDeviceLabel || '';
            await window.VTC.audio.populateMicDevices();
        }

        if (historyEnabledCheckbox) {
            historyEnabledCheckbox.checked = sttConfig?.historyEnabled === true;
            if (historyControlsGroup) historyControlsGroup.style.display = sttConfig?.historyEnabled === true ? 'block' : 'none';
        }
        if (requestId !== refreshRequestId) return;
        await renderHistoryList(historySearchInput ? historySearchInput.value : '');
        if (requestId !== refreshRequestId) return;

        if (removeKeyBtn) {
            removeKeyBtn.style.display = (apiStatus?.source === 'config' || (apiStatus?.count || 0) > 0) ? 'inline-block' : 'none';
            const envKeyConfigured = apiStatus?.source === 'env';
            removeKeyBtn.disabled = envKeyConfigured;
            removeKeyBtn.title = envKeyConfigured ? t('gemini.envKeyTitle') : '';
            if (envKeyConfigured) {
                if (geminiKeyGroup) geminiKeyGroup.style.display = 'none';
                if (apiKeyNote) apiKeyNote.innerHTML = t('gemini.envKeyNote');
            } else {
                const nKeys = apiStatus?.count || 0;
                if (apiKeyNote) {
                    if (nKeys > 0) {
                        apiKeyNote.textContent = t('gemini.keySaved');
                    } else {
                        apiKeyNote.innerHTML = t('gemini.noKey', { url: 'https://aistudio.google.com/apikey' });
                    }
                }
            }
        }

        const appVersionDisplay = document.getElementById('app-version-display');
        if (appVersionDisplay) {
            const ver = window.api && window.api.appVersion ? window.api.appVersion : '5.0.0';
            appVersionDisplay.textContent = `v${ver}`;
        }

        // Keep the cooldown note honest on every settings open: cooldown
        // writes in gemini.js don't broadcast, so refresh it here directly.
        if (sttConfig?.sttEngine === 'gemini') {
            const cooldowns = await window.api?.getGeminiCooldowns?.() || {};
            const keyNote = document.getElementById('api-key-note');
            const activeKeys = Number(cooldowns.keysActive) || 0;
            const activeModels = Number(cooldowns.modelsActive) || 0;
            if (keyNote && (activeKeys > 0 || activeModels > 0)) {
                keyNote.textContent = t('gemini.cooldownState', {
                    keys: activeKeys,
                    models: activeModels,
                    s: cooldowns.nextRetryInSec || cooldowns.retryInSec || 0
                });
            }
        }

        if (requestId !== refreshRequestId) return;
        await checkModelStatus();
    }

    function openSettings(fromMain = false) {
        // The main process expands the existing widget first, then sends the
        // open-settings event back. Keeping that boundary here prevents a
        // tiny 232px widget from trying to render the full modal.
        if (!fromMain && window.api?.showSettingsWindow) {
            window.api.showSettingsWindow();
            return;
        }
        if (!settingsModal) return;
        if (settingsModal.classList.contains('active')) {
            closeModalBtn?.focus();
            if (pendingExternalActivation) {
                pendingExternalActivation = false;
                refreshSettingsUi().catch(() => {});
            }
            return;
        }
        pendingExternalActivation = false;
        lastFocusedBeforeSettings = document.activeElement;
        settingsModal.classList.add('active');
        settingsModal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('settings-active');
        window.VTC?.interaction?.refreshMouseIgnore();
        // Refreshing fields does not change modal-body.scrollTop, so users can
        // interact with controls without being bounced back to the beginning.
        refreshSettingsUi().catch(() => {});
        requestAnimationFrame(() => closeModalBtn?.focus());
    }

    function closeSettings() {
        flushPendingSettingsSave();
        if (!settingsModal) return;
        if (!isSettingsWindow && !settingsModal.classList.contains('active')) return;
        window.VTC?.vad?.stopSettingsMicPreview();
        window.VTC?.audio?.stopMicTest();
        if (activeDownloadKey) {
            const downloadingKey = activeDownloadKey;
            activeDownloadKey = null;
            window.api?.cancelLocalModelDownload(downloadingKey).catch(() => {});
        }
        settingsModal.classList.remove('active');
        settingsModal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('settings-active');
        window.VTC?.interaction?.refreshMouseIgnore();
        if (window.api?.closeSettingsWindow) {
            window.api.closeSettingsWindow();
        } else if (isSettingsWindow) {
            window.close();
        }
        // Restore keyboard focus to whatever opened the settings UI.
        if (lastFocusedBeforeSettings && lastFocusedBeforeSettings.focus) {
            try { lastFocusedBeforeSettings.focus(); } catch (e) {}
        }
        lastFocusedBeforeSettings = null;
    }

    // Keyboard support: ESC closes settings once; Tab is trapped inside the
    // modal so focus can never land on the widget behind it.
    document.addEventListener('keydown', (e) => {
        const modalActive = isSettingsWindow || (settingsModal && settingsModal.classList.contains('active'));
        if (!modalActive) return;
        if (e.key === 'Escape') {
            if (modelDropdown?.classList.contains('open')) return; // dropdown owns ESC
            e.preventDefault();
            e.stopPropagation();
            closeSettings();
            return;
        }
        if (e.key !== 'Tab') return;
        const root = settingsModal;
        if (!root.contains(document.activeElement)) {
            // Focus escaped to the top bar behind the modal (e.g. the gear
            // button) — pull it back inside and let the normal trap continue.
            e.preventDefault();
            const focusables = [...root.querySelectorAll(
                'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )].filter(el => el.offsetParent !== null || el === document.activeElement);
            if (focusables.length) {
                (e.shiftKey ? focusables[focusables.length - 1] : focusables[0]).focus();
            }
            return;
        }
        const focusables = [...root.querySelectorAll(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )].filter(el => el.offsetParent !== null || el === document.activeElement);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    });

    // Attach form event listeners
    if (closeModalBtn) closeModalBtn.addEventListener('click', closeSettings);
    if (settingsBtn) settingsBtn.addEventListener('click', () => openSettings());
    if (closeBtn) closeBtn.addEventListener('click', () => window.close());
    if (engineBtnGemini) {
        engineBtnGemini.addEventListener('click', () => { setEngine('gemini'); autoSaveSettings(); });
        engineBtnGemini.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEngine('gemini'); autoSaveSettings(); }
        });
    }
    if (engineBtnLocal) {
        engineBtnLocal.addEventListener('click', () => { setEngine('local'); autoSaveSettings(); });
        engineBtnLocal.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEngine('local'); autoSaveSettings(); }
        });
    }

    if (localTierSelect) {
        localTierSelect.addEventListener('change', () => {
            updateLocalModelUi();
            checkModelStatus();
            autoSaveSettings();
        });
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

    if (outputModeSelectEl) {
        outputModeSelectEl.addEventListener('change', () => {
            updateOutputModeVisibility();
            autoSaveSettings();
        });
    }
    if (autotypeMethodSelectEl) {
        autotypeMethodSelectEl.addEventListener('change', () => autoSaveSettings());
    }
    if (pasteKeyInputEl) {
        pasteKeyInputEl.addEventListener('keydown', (e) => {
            if (['Tab', 'Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
            e.preventDefault();
            pasteKeyVal = e.key;
            pasteKeyInputEl.value = e.key === ' ' ? 'SPACE' : e.key.toUpperCase();
            autoSaveSettings();
        });
        pasteKeyInputEl.addEventListener('focus', () => { pasteKeyInputEl.select(); });
    }
    if (pressEnterCheckbox) {
        pressEnterCheckbox.addEventListener('change', () => autoSaveSettings());
    }
    if (alwaysCopyClipboardCheckbox) {
        alwaysCopyClipboardCheckbox.addEventListener('change', () => autoSaveSettings());
    }

    if (autoStopCheckbox) {
        autoStopCheckbox.addEventListener('change', () => {
            if (autoStopOptions) autoStopOptions.style.display = autoStopCheckbox.checked ? 'flex' : 'none';
            autoSaveSettings();
        });
    }
    if (autoStopSecondsSelect) autoStopSecondsSelect.addEventListener('change', () => autoSaveSettings());
    if (ecoModeCheckbox) ecoModeCheckbox.addEventListener('change', () => autoSaveSettings());
    if (alwaysOnTopCheckbox) alwaysOnTopCheckbox.addEventListener('change', () => autoSaveSettings());
    if (finishSoundCheckbox) finishSoundCheckbox.addEventListener('change', () => autoSaveSettings());
    if (apiKeyInput) apiKeyInput.addEventListener('change', () => autoSaveSettings());

    if (saveRecordingsCheckbox) {
        saveRecordingsCheckbox.addEventListener('change', () => {
            const recordingsFolderDetails = document.getElementById('recordings-folder-details');
            if (recordingsFolderDetails) {
                recordingsFolderDetails.style.display = saveRecordingsCheckbox.checked ? 'block' : 'none';
            }
            autoSaveSettings();
        });
    }

    if (openRecordingsBtn) {
        openRecordingsBtn.addEventListener('click', async () => {
            await window.api?.openRecordingsFolder();
        });
    }

    if (removeKeyBtn) {
        removeKeyBtn.addEventListener('click', async () => {
            await window.api?.removeApiKey();
            refreshSettingsUi();
        });
    }

    if (uiLanguageSelect) {
        uiLanguageSelect.addEventListener('change', () => {
            window.VTC?.i18n?.setUiLanguage(uiLanguageSelect.value);
            autoSaveSettings();
        });
    }

    if (historySearchInput) {
        // Debounced search: one IPC round-trip per pause, with a request
        // sequence guard so a slow response can never overwrite a newer one.
        let historySearchDebounce = null;
        historySearchInput.addEventListener('input', () => {
            clearTimeout(historySearchDebounce);
            historySearchDebounce = setTimeout(() => {
                renderHistoryList(historySearchInput.value);
            }, 180);
        });
    }
    if (historyEnabledCheckbox) {
        historyEnabledCheckbox.addEventListener('change', () => {
            if (historyControlsGroup) {
                historyControlsGroup.style.display = historyEnabledCheckbox.checked ? 'block' : 'none';
            }
            autoSaveSettings();
        });
    }
    if (historyClearBtn) {
        historyClearBtn.addEventListener('click', async () => {
            const t = window.VTC?.i18n?.t || ((k) => k);
            if (confirm(t('history.confirmClear'))) {
                await window.api?.history.clear();
                renderHistoryList(historySearchInput ? historySearchInput.value : '');
            }
        });
    }
    if (historyExportBtn) {
        historyExportBtn.addEventListener('click', async () => {
            const fmt = historyExportFormat ? historyExportFormat.value : 'json';
            await window.api?.history.export(fmt);
        });
    }

    wireStylePicker();

    window.addEventListener('pagehide', flushPendingSettingsSave);
    window.addEventListener('beforeunload', flushPendingSettingsSave);

    window.VTC.settings = {
        WIDGET_STYLES,
        MODEL_TIER_LABELS,
        loadModelCatalog,
        renderModelCard,
        buildModelDropdown,
        updateDropdownCurrent,
        selectModelTier,
        closeModelDropdown,
        applyModelRecommendation,
        rebuildModelViews: () => {
            if (modelCatalog && modelCatalog.length) {
                buildModelDropdown();
                renderModelCard();
            }
        },
        openSettings,
        markSettingsExternallyActivated() { pendingExternalActivation = true; },
        closeSettings,
        refreshSettingsUi,
        checkApiKeyStatus,
        checkModelStatus,
        autoSaveSettings,
        renderHistoryList,
        applyAppearanceSnapshot,
        setWidgetStyle,
        get currentWidgetStyle() { return currentWidgetStyle; },
        get currentSttConfig() { return currentSttConfig; },
        set currentSttConfig(v) { currentSttConfig = v; },
        get selectedEngine() { return selectedEngine; },
        get systemRamGB() { return systemRamGB; }
    };
})();
