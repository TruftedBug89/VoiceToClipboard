// src/main/delivery.js
// Transcription output dispatcher: clipboard, space-to-paste bubble, toast notification, and autotype injection.

const electron = require('electron');
const BrowserWindow = electron && typeof electron === 'object' ? electron.BrowserWindow : null;
const Notification = electron && typeof electron === 'object' ? electron.Notification : null;
const clipboard = electron && typeof electron === 'object' ? electron.clipboard : null;
const screen = electron && typeof electron === 'object' ? electron.screen : null;
const path = require('path');
const win32 = require('../../win32');
const { loadConfig, getUiLanguage } = require('./config-store');
const { WIDGET_STYLES } = require('../../stt/config');
const { L } = require('./i18n');
const { logger } = require('../../logger');

let lastExternalHwnd = null;
let bubbleWindow = null;
let bubbleTarget = null;
let bubbleText = '';
let bubbleTimer = null;
let bubblePendingText = '';
let pasteToast = null;
let lastDeliveryTyped = false;
let foregroundPoll = null;

function clipTranscript(text, head = 110, tail = 70) {
 const s = String(text || '').trim();
 if (s.length <= head + tail + 4) return s;
 let h = s.slice(0, head);
 const hs = h.lastIndexOf(' ');
 if (hs > head * 0.6) h = h.slice(0, hs);
 let tl = s.slice(-tail);
 const ts = tl.indexOf(' ');
 if (ts !== -1 && ts < tail * 0.4) tl = tl.slice(ts + 1);
 return `${h}…${tl}`;
}

function initForegroundPolling(getMainWindow) {
 if (foregroundPoll) clearInterval(foregroundPoll);
 foregroundPoll = setInterval(() => {
 const config = loadConfig();
 const needsTarget = config.outputMode === 'autotype' || config.outputMode === 'bubble' || config.outputMode === 'toast' || config.spacePaste;
 if (!needsTarget) return;
 const mainWin = getMainWindow ? getMainWindow() : null;
 if (!win32.available || !mainWin || mainWin.isDestroyed()) return;
 try {
 if (BrowserWindow.getFocusedWindow()) return;
 const hwnd = win32.getForegroundWindow();
 if (hwnd) lastExternalHwnd = hwnd;
 } catch (e) {}
 }, 500);
}

function stopForegroundPolling() {
 if (foregroundPoll) {
 clearInterval(foregroundPoll);
 foregroundPoll = null;
 }
}

function secureWebContents(webContents) {
 webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
 webContents.on('will-navigate', (event, url) => {
 if (url !== webContents.getURL()) event.preventDefault();
 });
}

function bubblePayload(text) {
 const config = loadConfig();
 const key = typeof config.pasteKey === 'string' && config.pasteKey ? config.pasteKey : ' ';
 const lang = getUiLanguage();
 return {
 text: clipTranscript(text),
 key,
 keyLabel: key === ' ' ? 'SPACE' : key.toUpperCase(),
 title: L('bubble.title', null, lang),
 // The bubble window cannot reach the widget DOM; pass the active theme
 // so bubble.css can reskin the card to match the widget.
 style: WIDGET_STYLES.includes(config.widgetStyle) ? config.widgetStyle : 'crimson'
 };
}

function ensureBubbleWindow() {
 if (bubbleWindow && !bubbleWindow.isDestroyed()) return;
 try {
 bubbleWindow = new BrowserWindow({
 width: 360,
 height: 96,
 show: false,
 frame: false,
 resizable: false,
 alwaysOnTop: true,
 skipTaskbar: true,
 focusable: true,
 hasShadow: true,
 transparent: true,
 webPreferences: {
 preload: path.join(__dirname, '../../bubble-preload.js'),
 nodeIntegration: false,
 contextIsolation: true,
 sandbox: false
 }
 });
 bubbleWindow.setAlwaysOnTop(true, 'screen-saver');
 secureWebContents(bubbleWindow.webContents);
 bubbleWindow.loadFile(path.join(__dirname, '../../bubble.html'));
 bubbleWindow.webContents.on('did-finish-load', () => {
 if (bubblePendingText && bubbleWindow && !bubbleWindow.isDestroyed()) {
 bubbleWindow.webContents.send('bubble-set-text', bubblePayload(bubblePendingText));
 }
 // Consume once: a later reload must not resurrect stale text.
 bubblePendingText = '';
 });
 bubbleWindow.on('closed', () => { bubbleWindow = null; });
 } catch (e) {
 // Window creation can throw during shutdown or under resource
 // pressure; degrade to clipboard-only delivery instead of throwing
 // through the transcription success path.
 logger.warn(`[delivery] bubble window creation failed: ${e && e.message ? e.message : e}`);
 bubbleWindow = null;
 }
}

function positionBubbleNear() {
 if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
 const W = 360, H = 96;
 const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
 const wa = disp.workArea;
 const padRight = 56;
 const padBottom = 64;
 const x = wa.x + wa.width - W - padRight;
 const y = wa.y + wa.height - H - padBottom;
 bubbleWindow.setPosition(Math.round(x), Math.round(y));
}

function closePasteBubble() {
 if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
 if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.destroy();
 bubbleWindow = null;
}

function pasteToTarget(target, text, pressEnter = false) {
 if (!target || !win32.isWindow(target)) return;
 if (clipboard && typeof clipboard.writeText === 'function') clipboard.writeText(text);
 win32.setForegroundWindow(target);
 setTimeout(() => {
 win32.sendCtrlV();
 if (pressEnter) {
 setTimeout(() => {
 win32.sendEnter();
 }, 60);
 }
 }, 80);
}

function maybeShowPasteToast(text) {
 if (!win32.available) return;
 if (!lastExternalHwnd || !win32.isWindow(lastExternalHwnd)) return;
 const clean = String(text || '').trim();
 if (!clean) return;
 if (pasteToast) { try { pasteToast.close(); } catch (e) {} }
 const lang = getUiLanguage();
 if (!Notification) return;
 const t = new Notification({
 title: L('toast.title', null, lang),
 body: clipTranscript(clean, 130, 90) + ' - ' + L('toast.body', null, lang),
 actions: [{ type: 'button', text: L('toast.action', null, lang) }],
 silent: true
 });
 pasteToast = t;
 // Once-guard: some Windows notification flows deliver both `action` and
 // `click` for a single interaction - paste exactly once per toast.
 let toastSettled = false;
 const pasteOnce = () => {
 if (toastSettled) return;
 toastSettled = true;
 const config = loadConfig();
 pasteToTarget(lastExternalHwnd, clean, !!config.pressEnter);
 };
 t.on('click', pasteOnce);
 t.on('action', pasteOnce);
 t.on('close', () => { if (pasteToast === t) pasteToast = null; });
 t.show();
}

function maybeShowPasteBubble(text) {
 if (!win32.available) return;
 if (!lastExternalHwnd || !win32.isWindow(lastExternalHwnd)) return;
 const clean = String(text || '').trim();
 if (!clean) return;
 bubbleText = clean;
 bubbleTarget = lastExternalHwnd;
 bubblePendingText = clean;
 ensureBubbleWindow();
 if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
 positionBubbleNear();
 if (!bubbleWindow.webContents.isLoading()) {
 bubbleWindow.webContents.send('bubble-set-text', bubblePayload(bubbleText));
 }
 bubbleWindow.show();
 bubbleWindow.focus();
 if (bubbleTimer) clearTimeout(bubbleTimer);
 bubbleTimer = setTimeout(closePasteBubble, 3000);
}

function handleBubblePaste() {
 const target = bubbleTarget;
 const text = bubbleText;
 closePasteBubble();
 if (!target || !win32.isWindow(target)) return;
 const config = loadConfig();
 pasteToTarget(target, text, !!config.pressEnter);
}

function deliverTranscriptionOutput(text) {
 lastDeliveryTyped = false;
 const clean = String(text || '').trim();
 if (!clean) return { success: true, delivered: 'none', typed: false };

 const config = loadConfig();
 const mode = config.outputMode || 'clipboard';
 const shouldSaveToClipboard = config.alwaysCopyToClipboard !== false || mode === 'clipboard';

 // Always keep transcript in clipboard so Ctrl+V is ready as fallback
 if (shouldSaveToClipboard && clipboard && typeof clipboard.writeText === 'function') {
 clipboard.writeText(clean);
 }

 if (mode === 'autotype') {
 const target = lastExternalHwnd;
 let typed = false;
 if (win32.available && target && win32.isWindow(target)) {
 if (config.autotypeMethod === 'paste') {
 pasteToTarget(target, clean, !!config.pressEnter);
 typed = true;
 } else {
 win32.setForegroundWindow(target);
 // SetForegroundWindow completes asynchronously on Windows:
 // injecting immediately races the focus switch and can drop
 // keystrokes into the previous window. Defer typing like the
 // paste path does. typeUnicodeText only returns false before
 // any batch lands, so the deferred fallback below can never
 // duplicate partially typed text.
 typed = true;
 setTimeout(() => {
 const ok = win32.typeUnicodeText(clean);
 if (!ok) {
 logger.warn('[delivery] unicode autotype injected nothing; falling back to paste bubble');
 lastDeliveryTyped = false;
 maybeShowPasteBubble(clean);
 return;
 }
 if (config.pressEnter) {
 setTimeout(() => {
 win32.sendEnter();
 }, 50);
 }
 }, 80);
 }
 }

 if (typed) {
 lastDeliveryTyped = true;
 return { success: true, delivered: 'autotype', typed: true };
 }

 logger.warn('[delivery] autotype failed or target window invalid; falling back to paste bubble');
 maybeShowPasteBubble(clean);
 return { success: true, delivered: 'bubble', typed: false, fallback: true };
 }

 if (mode === 'toast') {
 maybeShowPasteToast(clean);
 return { success: true, delivered: 'toast', typed: false };
 }

 if (mode === 'bubble') {
 maybeShowPasteBubble(clean);
 return { success: true, delivered: 'bubble', typed: false };
 }

 return { success: true, delivered: 'clipboard', typed: false };
}

module.exports = {
 clipTranscript,
 initForegroundPolling,
 stopForegroundPolling,
 ensureBubbleWindow,
 closePasteBubble,
 handleBubblePaste,
 pasteToTarget,
 maybeShowPasteToast,
 maybeShowPasteBubble,
 deliverTranscriptionOutput,
 get lastDeliveryTyped() { return lastDeliveryTyped; },
 get lastExternalHwnd() { return lastExternalHwnd; },
 set lastExternalHwnd(v) { lastExternalHwnd = v; }
};
