// Preload for the transient paste bubble.
const { contextBridge, ipcRenderer } = require('electron');

// Single replace-on-reregister listener, mirroring preload.js on() semantics:
// re-calling onSetText swaps the callback instead of stacking duplicates.
let setTextListener = null;

contextBridge.exposeInMainWorld('bubbleApi', {
    onSetText: (cb) => {
        if (typeof cb !== 'function') return;
        if (setTextListener) ipcRenderer.removeListener('bubble-set-text', setTextListener);
        setTextListener = (_e, payload) => cb(payload);
        ipcRenderer.on('bubble-set-text', setTextListener);
    },
    paste: () => ipcRenderer.send('bubble-paste'),
    dismiss: () => ipcRenderer.send('bubble-dismiss'),
});
