// renderer.js
// Main renderer bootstrap: listens to IPC push channels, coordinates UI modules, and starts animation loops.

(function () {
    const isSettingsWindow = new URLSearchParams(window.location.search).get('settings') === '1';
    if (isSettingsWindow) document.body.classList.add('settings-window');

    // IPC Push Subscriptions
    window.api?.on('settings-changed', async (snapshot) => {
        window.VTC.settings.currentSttConfig = snapshot;
        window.VTC.settings.applyAppearanceSnapshot(snapshot);
        if (typeof snapshot.uiLanguage === 'string' && snapshot.uiLanguage !== window.VTC.i18n.uiLang) {
            window.VTC.i18n.setUiLanguage(snapshot.uiLanguage);
        }
        if (isSettingsWindow) window.VTC.settings.refreshSettingsUi(snapshot);
        await window.VTC.settings.checkApiKeyStatus();
    });

    window.api?.on('sync-settings', () => {
        window.VTC.settings.refreshSettingsUi();
    });

    window.api?.on('models-changed', async () => {
        await window.VTC.settings.loadModelCatalog();
        await window.VTC.settings.checkModelStatus();
        window.VTC.settings.buildModelDropdown();
        window.VTC.settings.renderModelCard();
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
        window.VTC.settings.openSettings();
    });

    window.api?.on('gemini-fallback', (model) => {
        window.VTC.recording.setStatus('busy', `Rate limit — switched to ${model}`);
    });

    async function initializeRenderer() {
        await window.VTC.settings.loadModelCatalog();
        const snapshot = await window.api?.getSttConfig();
        window.VTC.settings.applyAppearanceSnapshot(snapshot);
        window.VTC.i18n.applyI18n(snapshot?.uiLanguage || 'en');

        const settingsModal = document.getElementById('settings-modal');
        if (isSettingsWindow && settingsModal) {
            settingsModal.classList.add('active');
            await window.VTC.settings.refreshSettingsUi(snapshot);
        } else {
            window.VTC.settings.currentSttConfig = snapshot;
            window.VTC.settings.applyModelRecommendation(snapshot);
        }
        await window.VTC.settings.checkApiKeyStatus();

        // Start visualizer animation loop
        requestAnimationFrame(() => window.VTC.visualizer.drawVisualizer());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeRenderer);
    } else {
        initializeRenderer().catch(err => console.error('Renderer initialization error:', err));
    }
})();
