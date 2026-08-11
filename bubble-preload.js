// Preload for the transient paste bubble.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bubbleApi', {
    onSetText: (cb) => ipcRenderer.on('bubble-set-text', (_e, payload) => cb(payload)),
    paste: () => ipcRenderer.send('bubble-paste'),
    dismiss: () => ipcRenderer.send('bubble-dismiss'),
});
