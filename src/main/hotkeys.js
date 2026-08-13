// src/main/hotkeys.js
// Low-level global keyboard and mouse hotkey capture via uiohook-napi.

const { uIOhook, UiohookKey } = require('uiohook-napi');
const { loadConfig, saveConfig } = require('./config-store');

const reverseKeyMap = Object.entries(UiohookKey).reduce((acc, [k, v]) => { acc[v] = k; return acc; }, {});

let currentHotkeyConfig = null;
let isRecordingHotkey = false;
let hotkeyPromiseResolve = null;
let hotkeyCaptureTimeout = null;

function applyHotkeyConfig(hk) {
    if (!hk) {
        currentHotkeyConfig = { type: 'keyboard', keycode: UiohookKey.V, ctrl: true, alt: true, shift: false };
    } else {
        currentHotkeyConfig = hk;
    }
}

function formatHotkey(hk) {
    if (!hk) return 'Ctrl + Alt + V';
    let parts = [];
    if (hk.ctrl) parts.push('Ctrl');
    if (hk.alt) parts.push('Alt');
    if (hk.shift) parts.push('Shift');
    if (hk.type === 'mouse') {
        parts.push(`Mouse ${hk.button}`);
    } else {
        let keyName = reverseKeyMap[hk.keycode] || `Keycode ${hk.keycode}`;
        parts.push(keyName);
    }
    return parts.join(' + ');
}

function settleHotkeyCapture() {
    if (hotkeyCaptureTimeout) {
        clearTimeout(hotkeyCaptureTimeout);
        hotkeyCaptureTimeout = null;
    }
    isRecordingHotkey = false;
    if (hotkeyPromiseResolve) {
        const finish = hotkeyPromiseResolve;
        hotkeyPromiseResolve = null;
        finish(formatHotkey(loadConfig().customHotkey || currentHotkeyConfig));
    }
}

function startRecordingHotkey() {
    settleHotkeyCapture();
    isRecordingHotkey = true;
    return new Promise((resolve) => {
        hotkeyPromiseResolve = (hk) => {
            if (hotkeyCaptureTimeout) { clearTimeout(hotkeyCaptureTimeout); hotkeyCaptureTimeout = null; }
            applyHotkeyConfig(hk);
            saveConfig({ customHotkey: hk });
            resolve(formatHotkey(hk));
        };
        hotkeyCaptureTimeout = setTimeout(() => {
            hotkeyCaptureTimeout = null;
            if (hotkeyPromiseResolve) {
                const finish = hotkeyPromiseResolve;
                hotkeyPromiseResolve = null;
                isRecordingHotkey = false;
                finish(formatHotkey(loadConfig().customHotkey || currentHotkeyConfig));
            }
        }, 10000);
    });
}

function initHotkeys({ onToggleRecording = () => {} } = {}) {
    uIOhook.on('keydown', (e) => {
        if (isRecordingHotkey) {
            if ([UiohookKey.Ctrl, UiohookKey.Alt, UiohookKey.Shift, UiohookKey.CtrlRight, UiohookKey.AltRight, UiohookKey.ShiftRight, UiohookKey.Meta].includes(e.keycode)) return;
            isRecordingHotkey = false;
            const hk = { type: 'keyboard', keycode: e.keycode, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
            if (hotkeyPromiseResolve) {
                hotkeyPromiseResolve(hk);
                hotkeyPromiseResolve = null;
            }
            return;
        }

        if (currentHotkeyConfig && currentHotkeyConfig.type === 'keyboard') {
            if (e.keycode === currentHotkeyConfig.keycode &&
                !!e.ctrlKey === !!currentHotkeyConfig.ctrl &&
                !!e.altKey === !!currentHotkeyConfig.alt &&
                !!e.shiftKey === !!currentHotkeyConfig.shift) {
                onToggleRecording();
            }
        }
    });

    uIOhook.on('mousedown', (e) => {
        if (isRecordingHotkey) {
            if (e.button === 1 && !e.ctrlKey && !e.altKey && !e.shiftKey) return;
            isRecordingHotkey = false;
            const hk = { type: 'mouse', button: e.button, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
            if (hotkeyPromiseResolve) {
                hotkeyPromiseResolve(hk);
                hotkeyPromiseResolve = null;
            }
            return;
        }

        if (currentHotkeyConfig && currentHotkeyConfig.type === 'mouse') {
            if (e.button === currentHotkeyConfig.button &&
                !!e.ctrlKey === !!currentHotkeyConfig.ctrl &&
                !!e.altKey === !!currentHotkeyConfig.alt &&
                !!e.shiftKey === !!currentHotkeyConfig.shift) {
                onToggleRecording();
            }
        }
    });

    const config = loadConfig();
    applyHotkeyConfig(config.customHotkey);
    uIOhook.start();
}

function stopHotkeys() {
    try {
        uIOhook.stop();
    } catch (e) {}
}

module.exports = {
    applyHotkeyConfig,
    formatHotkey,
    settleHotkeyCapture,
    startRecordingHotkey,
    initHotkeys,
    stopHotkeys,
    get currentHotkeyConfig() { return currentHotkeyConfig; }
};
