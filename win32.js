// Minimal Win32 helpers via koffi (user32.dll) — used by the space-to-paste bubble & autotype injection.
// Falls back gracefully if koffi can't load: the feature simply disables itself.
const koffi = require('koffi');

const VK_CONTROL = 0x11;
const VK_V = 0x56;
const VK_RETURN = 0x0D;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const INPUT_KEYBOARD = 1;

let api = null;
try {
    const user32 = koffi.load('user32.dll');
    koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    koffi.struct('POINT', { x: 'long', y: 'long' });
    koffi.struct('KEYBDINPUT', {
        wVk: 'ushort',
        wScan: 'ushort',
        dwFlags: 'uint32',
        time: 'uint32',
        dwExtraInfo: 'uintptr'
    });
    if (process.arch === 'x64') {
        koffi.struct('INPUT', {
            type: 'uint32',
            padding: 'uint32',
            ki: 'KEYBDINPUT',
            dummy: 'uint64'
        });
    } else {
        koffi.struct('INPUT', {
            type: 'uint32',
            ki: 'KEYBDINPUT',
            dummy: 'uint64'
        });
    }

    api = {
        getForegroundWindow: user32.func('void* GetForegroundWindow(void)'),
        getWindowRect: user32.func('bool GetWindowRect(void* hwnd, _Out_ RECT *rect)'),
        getCursorPos: user32.func('bool GetCursorPos(_Out_ POINT *pt)'),
        setForegroundWindow: user32.func('bool SetForegroundWindow(void* hwnd)'),
        isWindow: user32.func('bool IsWindow(void* hwnd)'),
        keybdEvent: user32.func('void keybd_event(uchar bVk, uchar bScan, uint dwFlags, void* dwExtraInfo)'),
        sendInput: user32.func('uint SendInput(uint cInputs, INPUT *pInputs, int cbSize)')
    };
} catch (err) {
    console.warn('[win32] helpers unavailable:', err && err.message ? err.message : err);
}

function sendCtrlV() {
    if (!api) return false;
    try {
        api.keybdEvent(VK_CONTROL, 0, 0, null);
        api.keybdEvent(VK_V, 0, 0, null);
        api.keybdEvent(VK_V, 0, KEYEVENTF_KEYUP, null);
        api.keybdEvent(VK_CONTROL, 0, KEYEVENTF_KEYUP, null);
        return true;
    } catch (err) {
        console.warn('[win32] sendCtrlV failed:', err && err.message ? err.message : err);
        return false;
    }
}

function sendEnter() {
    if (!api) return false;
    try {
        api.keybdEvent(VK_RETURN, 0, 0, null);
        api.keybdEvent(VK_RETURN, 0, KEYEVENTF_KEYUP, null);
        return true;
    } catch (err) {
        console.warn('[win32] sendEnter failed:', err && err.message ? err.message : err);
        return false;
    }
}

function typeUnicodeText(text) {
    if (!api || !api.sendInput) return false;
    if (typeof text !== 'string' || text.length === 0) return true;

    try {
        const inputs = [];
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === '\r') {
                if (i + 1 < text.length && text[i + 1] === '\n') continue;
                inputs.push(
                    { type: INPUT_KEYBOARD, padding: 0, ki: { wVk: VK_RETURN, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 }, dummy: 0 },
                    { type: INPUT_KEYBOARD, padding: 0, ki: { wVk: VK_RETURN, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 }, dummy: 0 }
                );
            } else if (ch === '\n') {
                inputs.push(
                    { type: INPUT_KEYBOARD, padding: 0, ki: { wVk: VK_RETURN, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 }, dummy: 0 },
                    { type: INPUT_KEYBOARD, padding: 0, ki: { wVk: VK_RETURN, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 }, dummy: 0 }
                );
            } else {
                const codeUnit = text.charCodeAt(i);
                inputs.push(
                    { type: INPUT_KEYBOARD, padding: 0, ki: { wVk: 0, wScan: codeUnit, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 }, dummy: 0 },
                    { type: INPUT_KEYBOARD, padding: 0, ki: { wVk: 0, wScan: codeUnit, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 }, dummy: 0 }
                );
            }
        }

        const batchSize = 100;
        const inputStructSize = koffi.sizeof('INPUT');
        for (let b = 0; b < inputs.length; b += batchSize) {
            const chunk = inputs.slice(b, b + batchSize);
            const sent = api.sendInput(chunk.length, chunk, inputStructSize);
            if (sent !== chunk.length) {
                console.warn(`[win32] SendInput partial send: ${sent}/${chunk.length}`);
                if (sent === 0) return false;
            }
        }
        return true;
    } catch (err) {
        console.warn('[win32] typeUnicodeText failed:', err && err.message ? err.message : err);
        return false;
    }
}

function getWindowRectSafe(hwnd) {
    try {
        const rect = {};
        if (api && api.getWindowRect(hwnd, rect)) return rect;
    } catch (e) { /* fall through */ }
    return null;
}

function getCursorPosSafe() {
    try {
        const pt = {};
        if (api && api.getCursorPos(pt)) return pt;
    } catch (e) { /* fall through */ }
    return null;
}

module.exports = {
    get available() { return !!api; },
    getForegroundWindow: () => (api ? api.getForegroundWindow() : null),
    getWindowRect: getWindowRectSafe,
    getCursorPos: getCursorPosSafe,
    setForegroundWindow: (hwnd) => {
        try { return api ? !!api.setForegroundWindow(hwnd) : false; } catch (e) { return false; }
    },
    isWindow: (hwnd) => {
        try { return api ? !!api.isWindow(hwnd) : false; } catch (e) { return false; }
    },
    sendCtrlV,
    sendEnter,
    typeUnicodeText,
};
