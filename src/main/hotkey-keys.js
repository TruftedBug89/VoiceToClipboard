// src/main/hotkey-keys.js
// Pure hotkey key-name validation, kept separate from hotkeys.js (which pulls
// in the native uiohook-napi module) so unit tests can exercise it without
// native bindings. UiohookKey name strings look like 'A', '5', 'F7', 'Space',
// 'Escape', 'Minus', 'NumPad1', 'BracketLeft', etc.

const CAPTURABLE_NAMES = new Set([
    'Backspace', 'Tab', 'Enter', 'Space', 'CapsLock', 'Escape',
    'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
    'Up', 'Down', 'Left', 'Right',
    'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Semicolon',
    'Quote', 'Backquote', 'Comma', 'Period', 'Slash', 'Backslash',
    'PrintScreen', 'ScrollLock', 'Pause'
]);

const MODIFIER_NAMES = new Set([
    'Ctrl', 'Alt', 'Shift', 'CtrlRight', 'AltRight', 'ShiftRight', 'Meta'
]);

/**
 * True when the UiohookKey name can be used as the trigger key of a hotkey.
 * Letters, digits, F-keys and numpad keys pass via regex; the rest come from
 * an explicit whitelist. Modifiers alone are NOT capturable (the capture loop
 * ignores them and they only act as modifiers).
 */
function isCapturableKeyName(name) {
    if (typeof name !== 'string') return false;
    if (MODIFIER_NAMES.has(name)) return false;
    if (CAPTURABLE_NAMES.has(name)) return true;
    if (/^[A-Z]$/.test(name)) return true;
    if (/^\d$/.test(name)) return true;
    if (/^F([1-9]|1\d|2[0-4])$/.test(name)) return true;
    if (/^NumPad\d$/.test(name) || /^Num\d$/.test(name)) return true;
    return false;
}

function isModifierKeyName(name) {
    return MODIFIER_NAMES.has(name);
}

function isEscapeKeyName(name) {
    return name === 'Escape';
}

module.exports = { isCapturableKeyName, isModifierKeyName, isEscapeKeyName };
