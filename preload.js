// Preload for the widget + settings windows (contextIsolation: true, nodeIntegration: false).
// Exposes a minimal, typed IPC surface as window.api - the renderer can no longer
// require('electron') or reach arbitrary Node/Electron internals.
const { contextBridge, ipcRenderer } = require('electron');
const en = require('./locales/en.json');
const es = require('./locales/es.json');
const zh = require('./locales/zh.json');

// Main-renderer push channels the frontend is allowed to subscribe to.
const LISTEN_CHANNELS = new Set([
 'settings-changed',
 'models-changed',
 'settings-layout-restored',
 'toggle-recording',
 'open-settings',
 'download-progress',
 'gemini-fallback',
 'widget-hover',
]);

const listenerMap = new Map();

function on(channel, callback) {
 if (!LISTEN_CHANNELS.has(channel) || typeof callback !== 'function') return () => {};
 let channelMap = listenerMap.get(channel);
 if (!channelMap) {
 channelMap = new Map();
 listenerMap.set(channel, channelMap);
 }
 if (channelMap.has(callback)) {
 ipcRenderer.removeListener(channel, channelMap.get(callback));
 }
 const listener = (_event, ...args) => callback(...args);
 channelMap.set(callback, listener);
 ipcRenderer.on(channel, listener);
 return () => removeListener(channel, callback);
}

function removeListener(channel, callback) {
 if (!LISTEN_CHANNELS.has(channel) || typeof callback !== 'function') return;
 const channelMap = listenerMap.get(channel);
 if (!channelMap) return;
 const listener = channelMap.get(callback);
 if (listener) {
 ipcRenderer.removeListener(channel, listener);
 channelMap.delete(callback);
 }
}

contextBridge.exposeInMainWorld('api', {
 appVersion: require('./package.json').version,
 locales: { en, es, zh },

 // invoke (request/response)
 getApiKeyStatus: () => ipcRenderer.invoke('get-api-key-status'),
 refreshEnvApiKey: () => ipcRenderer.invoke('refresh-env-api-key'),
 getGeminiCooldowns: () => ipcRenderer.invoke('get-gemini-cooldowns'),
 getSttConfig: () => ipcRenderer.invoke('get-stt-config'),
 markFirstRunDone: () => ipcRenderer.invoke('mark-first-run-done'),
 getModelCatalog: () => ipcRenderer.invoke('get-model-catalog'),
 saveSttConfig: (settings) => ipcRenderer.invoke('save-stt-config', settings),
 getHotkey: () => ipcRenderer.invoke('get-hotkey'),
 startRecordingHotkey: () => ipcRenderer.invoke('start-recording-hotkey'),
 checkModelDownloaded: (modelKey) => ipcRenderer.invoke('check-model-downloaded', modelKey),
 downloadLocalModel: (modelKey) => ipcRenderer.invoke('download-local-model', modelKey),
 cancelLocalModelDownload: (modelKey) => ipcRenderer.invoke('cancel-local-model-download', modelKey),
 removeLocalModel: (modelKey) => ipcRenderer.invoke('remove-local-model', modelKey),
 saveApiKey: (keys) => ipcRenderer.invoke('save-api-key', keys),
 removeApiKey: () => ipcRenderer.invoke('remove-api-key'),
 transcribeAudio: (request) => ipcRenderer.invoke('transcribe-audio', request),
 copyDiagnostics: (extra) => ipcRenderer.invoke('copy-diagnostics', extra),
 openRecordingsFolder: () => ipcRenderer.invoke('open-recordings-folder'),

 // history API
 history: {
 list: (query) => ipcRenderer.invoke('history-list', query),
 delete: (id) => ipcRenderer.invoke('history-delete', id),
 clear: () => ipcRenderer.invoke('history-clear'),
 export: (format) => ipcRenderer.invoke('history-export', format),
 },
 pasteText: (text) => ipcRenderer.invoke('paste-text', text),

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
