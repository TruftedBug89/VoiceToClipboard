// renderer.js
// Main renderer bootstrap: listens to IPC push channels, coordinates UI modules, and starts animation loops.

(function () {
    // IPC Push Subscriptions
    window.api?.on('settings-changed', async (snapshot) => {
        window.VTC.settings.currentSttConfig = snapshot;
        window.VTC.settings.applyAppearanceSnapshot(snapshot);
        if (typeof snapshot.uiLanguage === 'string' && snapshot.uiLanguage !== window.VTC.i18n.uiLang) {
            window.VTC.i18n.setUiLanguage(snapshot.uiLanguage);
        }
        if (document.getElementById('settings-modal')?.classList.contains('active')) {
            await window.VTC.settings.refreshSettingsUi(snapshot);
        }
        await window.VTC.settings.checkApiKeyStatus();
    });

    window.api?.on('models-changed', async () => {
        await window.VTC.settings.loadModelCatalog();
        await window.VTC.settings.checkModelStatus();
        await window.VTC.settings.checkApiKeyStatus();
    });

    window.api?.on('toggle-recording', () => {
        if (!window.VTC.recording.isRecording) {
            window.VTC.recording.startRecording();
        } else {
            window.VTC.recording.stopRecording();
        }
    });

    window.api?.on('open-settings', () => {
        window.VTC.settings.openSettings(true);
    });

    window.api?.on('settings-layout-restored', () => {
        window.VTC?.interaction?.refreshMouseIgnore();
    });

    window.api?.on('gemini-fallback', (payload) => {
        const model = typeof payload === 'string' ? payload : (payload && payload.model);
        const keyIndex = (payload && typeof payload === 'object' && typeof payload.keyIndex === 'number') ? payload.keyIndex : null;
        // Persistent degraded-mode feedback: stays visible until the next
        // successful transcription or an 8s timeout, whichever comes first.
        const t = window.VTC?.i18n?.t || ((k, v) => k);
        const msg = keyIndex && keyIndex > 1
            ? t('status.GEMINI_FALLBACK_KEY', { model: model || '?', keyIndex })
            : t('status.GEMINI_FALLBACK', { model: model || '?' });
        window.VTC.recording.setFallbackStatus(msg);
    });

    async function initializeRenderer() {
        // Separate settings window (index.html?settings=1): the modal fills
        // the whole surface and opens immediately on boot.
        const isSettingsWindow = new URLSearchParams(window.location.search).get('settings') === '1';
        if (isSettingsWindow) {
            document.body.classList.add('settings-window', 'settings-active');
            const modalEl = document.getElementById('settings-modal');
            if (modalEl) {
                modalEl.classList.add('active');
                modalEl.setAttribute('aria-hidden', 'false');
            }
            // The modal is shown before data arrives; remember that so the
            // first openSettings(true) below still runs its full UI sync.
            window.VTC?.settings?.markSettingsExternallyActivated?.();
        }

        // Boot feedback: show the busy badge immediately so a slow first
        // config round-trip never looks like a frozen window.
        const bootStartedAt = Date.now();
        window.VTC.recording.setStatus('busy', 'STARTING');

        // Safety watchdog: ensure STARTING badge is NEVER stuck on screen
        const safetyWatchdog = setTimeout(() => {
            if (!window.VTC.recording.isRecording && !window.VTC.recording.isStartingRecording) {
                window.VTC.recording.hideStatus();
            }
        }, 1200);

        try {
            // A failed config round-trip must not skip the settings-window
            // branch below; fall back to defaults instead of a dead surface.
            const snapshot = await window.api?.getSttConfig()?.catch((error) => {
                console.error('getSttConfig failed:', error);
                return null;
            });
            if (snapshot) {
                window.VTC.settings.applyAppearanceSnapshot(snapshot);
                window.VTC.i18n.applyI18n(snapshot?.uiLanguage || 'en');
                window.VTC.settings.currentSttConfig = snapshot;
                window.VTC.settings.applyModelRecommendation(snapshot);
            }

            if (isSettingsWindow) {
                await window.VTC.settings.loadModelCatalog().catch(() => {});
                await window.VTC.settings.checkApiKeyStatus().catch(() => {});
                // The modal was pre-activated above for instant first paint,
                // so openSettings() would early-return on its active check
                // and skip ALL field syncing (engine groups, tier values,
                // checkboxes, history). Refresh directly instead - this is
                // what actually populates the offline-models view.
                await window.VTC.settings.refreshSettingsUi().catch((e) => {
                    console.error('[render] settings refresh failed:', e);
                });
                document.getElementById('close-modal-btn')?.focus?.();
                return;
            }

            // Non-blocking background catalog and key checks for widget
            window.VTC.settings.loadModelCatalog().catch(() => {});
            window.VTC.settings.checkApiKeyStatus().catch(() => {});

            window.VTC.visualizer.startVisualizer();

            // First-run welcome tour: one time, dismissible, never blocks the
            // mic or global hotkey. The card itself is click-through except for
            // its compact acknowledgement button.
            if (snapshot?.firstRun) {
                const tour = document.getElementById('first-run-tour');
                if (tour) {
                    const modelHint = document.getElementById('first-run-model-hint');
                    if (modelHint) modelHint.hidden = !(snapshot.sttEngine === 'local' && !snapshot.isDownloaded);
                    tour.hidden = false;
                    document.body.classList.add('first-run-active');
                    document.getElementById('mic-button')?.classList.add('first-run-highlight');
                    document.getElementById('settings-btn')?.classList.add('first-run-highlight');
                    const dismiss = () => {
                        tour.hidden = true;
                        document.body.classList.remove('first-run-active');
                        document.getElementById('mic-button')?.classList.remove('first-run-highlight');
                        document.getElementById('settings-btn')?.classList.remove('first-run-highlight');
                        window.api?.markFirstRunDone?.();
                        document.removeEventListener('keydown', escHandler);
                    };
                    const escHandler = (e) => {
                        if (e.key === 'Escape' && !tour.hidden && !window.VTC.recording?.isRecording) {
                            e.preventDefault();
                            dismiss();
                        }
                    };
                    document.getElementById('first-run-dismiss')?.addEventListener('click', dismiss, { once: true });
                    document.addEventListener('keydown', escHandler);
                }
            }
        } catch (error) {
            console.error('Renderer init error:', error);
        } finally {
            clearTimeout(safetyWatchdog);
            const bootElapsed = Date.now() - bootStartedAt;
            setTimeout(() => {
                if (!window.VTC.recording.isRecording && !window.VTC.recording.isStartingRecording) {
                    window.VTC.recording.hideStatus();
                }
            }, Math.max(50, Math.min(500, 500 - bootElapsed)));
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initializeRenderer().catch(() => window.VTC?.recording?.hideStatus());
        });
    } else {
        initializeRenderer().catch(() => window.VTC?.recording?.hideStatus());
    }
})();
