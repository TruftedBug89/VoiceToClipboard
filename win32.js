// Minimal Win32 helpers via koffi (user32.dll) — used by the space-to-paste bubble.
// Falls back gracefully if koffi can't load: the feature simply disables itself.
const koffi = require('koffi');

const VK_CONTROL = 0x11;
const VK_V = 0x56;
const KEYEVENTF_KEYUP = 0x0002;

let api = null;
try {
    const user32 = koffi.load('user32.dll');
    koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    koffi.struct('POINT', { x: 'long', y: 'long' });
    api = {
        getForegroundWindow: user32.func('void* GetForegroundWindow(void)'),
        getWindowRect: user32.func('bool GetWindowRect(void* hwnd, _Out_ RECT *rect)'),
        getCursorPos: user32.func('bool GetCursorPos(_Out_ POINT *pt)'),
        setForegroundWindow: user32.func('bool SetForegroundWindow(void* hwnd)'),
        isWindow: user32.func('bool IsWindow(void* hwnd)'),
        keybdEvent: user32.func('void keybd_event(uchar bVk, uchar bScan, uint dwFlags, void* dwExtraInfo)'),
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
};
