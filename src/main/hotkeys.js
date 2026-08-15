// src/main/hotkeys.js
// Low-level global keyboard and mouse hotkey capture via uiohook-napi.

const { uIOhook, UiohookKey } = require('uiohook-napi');
const { loadConfig, saveConfig } = require('./config-store');
const { isCapturableKeyName, isModifierKeyName, isEscapeKeyName } = require('./hotkey-keys');
const { logger } = require('../../logger');

const reverseKeyMap = Object.entries(UiohookKey).reduce((acc, [k, v]) => { acc[v] = k; return acc; }, {});

let currentHotkeyConfig = null;
let isRecordingHotkey = false;
let hotkeyPromiseResolve = null;
let hotkeyCaptureTimeout = null;

const CAPTURE_RESULT = Object.freeze({
    ok: 'ok',
    cancelled: 'cancelled',
    invalid: 'invalid',
    timeout: 'timeout'
});

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

function currentHotkeyString() {
    return formatHotkey(loadConfig().customHotkey || currentHotkeyConfig);
}

function finishCapture(result, hotkeyStr) {
    if (hotkeyCaptureTimeout) {
        clearTimeout(hotkeyCaptureTimeout);
        hotkeyCaptureTimeout = null;
    }
    isRecordingHotkey = false;
    if (hotkeyPromiseResolve) {
        const finish = hotkeyPromiseResolve;
        hotkeyPromiseResolve = null;
        finish({ result, hotkey: hotkeyStr });
    }
}

function settleHotkeyCapture() {
    finishCapture(CAPTURE_RESULT.ok, currentHotkeyString());
}

function startRecordingHotkey() {
    settleHotkeyCapture();
    isRecordingHotkey = true;
    return new Promise((resolve) => {
        hotkeyPromiseResolve = (payload) => {
            const { result, hotkey } = payload || {};
            if (result === CAPTURE_RESULT.ok) {
                const hk = result === CAPTURE_RESULT.ok ? loadConfig().customHotkey || currentHotkeyConfig : null;
                applyHotkeyConfig(hk);
            }
            resolve(payload);
        };
        hotkeyCaptureTimeout = setTimeout(() => {
            hotkeyCaptureTimeout = null;
            finishCapture(CAPTURE_RESULT.timeout, currentHotkeyString());
        }, 10000);
    });
}

function initHotkeys({ onToggleRecording = () => {} } = {}) {
    uIOhook.on('keydown', (e) => {
        if (isRecordingHotkey) {
            const keyName = reverseKeyMap[e.keycode] || null;
            // Modifiers alone are not a hotkey — wait for the trigger key.
            if (keyName && isModifierKeyName(keyName)) return;
            // Escape cancels capture instead of becoming the hotkey.
            if (keyName && isEscapeKeyName(keyName)) {
                finishCapture(CAPTURE_RESULT.cancelled, currentHotkeyString());
                return;
            }
            // Non-US layouts / exotic keys can surface codes we can't reliably
            // register; reject them instead of silently storing a dead hotkey.
            if (!keyName || !isCapturableKeyName(keyName)) {
                finishCapture(CAPTURE_RESULT.invalid, currentHotkeyString());
                return;
            }
            const hk = { type: 'keyboard', keycode: e.keycode, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
            if (hotkeyCaptureTimeout) { clearTimeout(hotkeyCaptureTimeout); hotkeyCaptureTimeout = null; }
            isRecordingHotkey = false;
            applyHotkeyConfig(hk);
            saveConfig({ customHotkey: hk });
            if (hotkeyPromiseResolve) {
                const finish = hotkeyPromiseResolve;
                hotkeyPromiseResolve = null;
                finish({ result: CAPTURE_RESULT.ok, hotkey: formatHotkey(hk) });
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
            const hk = { type: 'mouse', button: e.button, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
            if (hotkeyCaptureTimeout) { clearTimeout(hotkeyCaptureTimeout); hotkeyCaptureTimeout = null; }
            isRecordingHotkey = false;
            applyHotkeyConfig(hk);
            saveConfig({ customHotkey: hk });
            if (hotkeyPromiseResolve) {
                const finish = hotkeyPromiseResolve;
                hotkeyPromiseResolve = null;
                finish({ result: CAPTURE_RESULT.ok, hotkey: formatHotkey(hk) });
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
    // Reject a persisted custom hotkey whose trigger key is no longer
    // capturable (e.g. saved by an older version with a layout-specific
    // keycode): fall back to the default instead of a dead hotkey.
    if (config.customHotkey && config.customHotkey.type === 'keyboard') {
        const keyName = reverseKeyMap[config.customHotkey.keycode] || null;
        if (!keyName || !isCapturableKeyName(keyName)) {
            logger.warn(`[hotkeys] stored hotkey uses uncapturable key ${keyName || config.customHotkey.keycode} — resetting to default`);
            saveConfig({ customHotkey: null });
        }
    }
    applyHotkeyConfig(loadConfig().customHotkey);
    uIOhook.start();
}

function stopHotkeys() {
    try {
        uIOhook.stop();
    } catch (e) {}
    // Drop the keydown/mousedown listeners too: stop() only pauses the hook
    // thread, and a leftover listener that fires during shutdown can call
    // into a destroyed window.
    try {
        uIOhook.removeAllListeners('keydown');
        uIOhook.removeAllListeners('mousedown');
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