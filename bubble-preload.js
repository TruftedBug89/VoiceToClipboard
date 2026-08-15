// Preload for the transient paste bubble.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bubbleApi', {
    // Synchronous, appearance-only bootstrap used before the bubble stylesheet
    // is parsed. It never exposes config or credential values to the renderer.
    getInitialAppearance: () => ipcRenderer.sendSync('get-initial-appearance'),
    onSetText: (cb) => ipcRenderer.on('bubble-set-text', (_e, payload) => cb(payload)),
    paste: () => ipcRenderer.send('bubble-paste'),
    dismiss: () => ipcRenderer.send('bubble-dismiss'),
});
