// Preload for the widget + settings windows (contextIsolation: true, nodeIntegration: false).
// Exposes a minimal, typed IPC surface as window.api — the renderer can no longer
// require('electron') or reach arbitrary Node/Electron internals.
const { contextBridge, ipcRenderer } = require('electron');

// Main-renderer push channels the frontend is allowed to subscribe to.
const LISTEN_CHANNELS = new Set([
    'settings-changed',
    'models-changed',
    'settings-window-closed',
    'toggle-recording',
    'open-settings',
    'download-progress',
    'gemini-fallback',
    'widget-hover',
    'sync-settings',
]);

function on(channel, callback) {
    if (!LISTEN_CHANNELS.has(channel) || typeof callback !== 'function') return () => {};
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

function removeListener(channel, callback) {
    if (!LISTEN_CHANNELS.has(channel) || typeof callback !== 'function') return;
    // Remove every wrapped listener registered for this channel (used by
    // download-progress teardown in the renderer).
    ipcRenderer.removeAllListeners(channel);
}

contextBridge.exposeInMainWorld('api', {
    // invoke (request/response)
    getApiKeyStatus: () => ipcRenderer.invoke('get-api-key-status'),
    getSttConfig: () => ipcRenderer.invoke('get-stt-config'),
    getModelCatalog: () => ipcRenderer.invoke('get-model-catalog'),
    saveSttConfig: (settings) => ipcRenderer.invoke('save-stt-config', settings),
    getHotkey: () => ipcRenderer.invoke('get-hotkey'),
    startRecordingHotkey: () => ipcRenderer.invoke('start-recording-hotkey'),
    checkModelDownloaded: (modelKey) => ipcRenderer.invoke('check-model-downloaded', modelKey),
    downloadLocalModel: (modelKey) => ipcRenderer.invoke('download-local-model', modelKey),
    removeLocalModel: (modelKey) => ipcRenderer.invoke('remove-local-model', modelKey),
    saveApiKey: (keys) => ipcRenderer.invoke('save-api-key', keys),
    removeApiKey: () => ipcRenderer.invoke('remove-api-key'),
    transcribeAudio: (request) => ipcRenderer.invoke('transcribe-audio', request),
    copyDiagnostics: (extra) => ipcRenderer.invoke('copy-diagnostics', extra),

    // send (fire-and-forget)
    rendererLog: (msg) => ipcRenderer.send('renderer-log', msg),
    showSettingsWindow: () => ipcRenderer.send('show-settings-window'),
    closeSettingsWindow: () => ipcRenderer.send('close-settings-window'),
    dragStart: () => ipcRenderer.send('drag-start'),
    dragMove: () => ipcRenderer.send('drag-move'),
    dragEnd: () => ipcRenderer.send('drag-end'),
    setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
    widgetRaise: () => ipcRenderer.send('widget-raise'),

    // push subscriptions (channel validated against a whitelist)
    on,
    removeListener,
});
