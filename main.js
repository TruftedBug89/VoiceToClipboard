const { app, BrowserWindow, ipcMain, clipboard, Tray, Menu, nativeImage, screen, Notification } = require('electron');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { SttService } = require('./stt');
const { migrateConfig, validateSttConfig, systemRamGB, recommendedTierForRam } = require('./stt/config');
const { getModelKey } = require('./stt/model-registry');
const win32 = require('./win32');

// Gemini failover ladder (best → worst). Models that hit a daily rate limit
// get a 24h cooldown persisted in config so restarts still skip them.
const GEMINI_MODEL_LADDER = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
const GEMINI_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const reverseKeyMap = Object.entries(UiohookKey).reduce((acc, [k, v]) => { acc[v] = k; return acc; }, {});


app.disableHardwareAcceleration();
// Windows App User Model ID — required before windows are created so the
// taskbar groups the app correctly and pinning the icon works properly.
app.setAppUserModelId('com.voicetoclipboard.app');

const canonicalUserDataPath = path.join(app.getPath('appData'), 'VoiceToClipboard');
app.setPath('userData', canonicalUserDataPath);

// Ensure single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
            mainWindow.show();
        }
    });
}

let mainWindow;
let settingsWindow = null;
let tray = null;
const configPath = path.join(canonicalUserDataPath, 'config.json');
const modelsDir = path.join(canonicalUserDataPath, 'models');

// App log: writes to %APPDATA%\VoiceToClipboard\app.log — writable in BOTH dev
// and packaged (asar) runs (the old __dirname target silently fails when
// packaged, leaving the exe with zero observability).
function logApp(msg) {
    try {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        fs.appendFileSync(path.join(canonicalUserDataPath, 'app.log'), line);
    } catch (e) { /* logging must never crash the app */ }
}
// Redact anything that looks like a secret before it reaches the log.
function redactLog(s) {
    return String(s)
        .replace(/AIza[0-9A-Za-z_\-]{20,}/g, 'AIza…REDACTED')
        .replace(/(key|api[_-]?key|token)=[^&\s"']+/gi, '$1=REDACTED');
}
const legacyUserDataPaths = [
    path.join(app.getPath('appData'), 'voicetoclipboard')
];

async function migrateLegacyUserData() {
    await fs.promises.mkdir(canonicalUserDataPath, { recursive: true });
    for (const legacyPath of legacyUserDataPaths) {
        if (path.resolve(legacyPath) === path.resolve(canonicalUserDataPath) || !fs.existsSync(legacyPath)) continue;

        const legacyConfigPath = path.join(legacyPath, 'config.json');
        if (!fs.existsSync(configPath) && fs.existsSync(legacyConfigPath)) {
            await fs.promises.copyFile(legacyConfigPath, configPath);
        }

        const legacyModelsPath = path.join(legacyPath, 'models');
        if (!fs.existsSync(legacyModelsPath)) continue;
        await fs.promises.mkdir(modelsDir, { recursive: true });
        const entries = await fs.promises.readdir(legacyModelsPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory() || !/^[a-z0-9-]+$/.test(entry.name)) continue;
            const source = path.join(legacyModelsPath, entry.name);
            const target = path.join(modelsDir, entry.name);
            if (!fs.existsSync(target)) await fs.promises.cp(source, target, { recursive: true, errorOnExist: true });
        }
    }
}

// Helper to load config
function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            return migrateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
        }
    } catch (e) {
        console.error("Failed to load config:", e.message || e);
    }
    return migrateConfig({});
}

function saveConfig(data) {
    try {
        const config = migrateConfig({ ...loadConfig(), ...data });
        const tempPath = `${configPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf8');
        fs.renameSync(tempPath, configPath);
        return true;
    } catch (e) {
        console.error("Failed to save config:", e.message || e);
        return false;
    }
}

async function getSettingsSnapshot() {
    const config = loadConfig();
    const localModelKey = getModelKey(config.localTier, config.localLanguage);
    const modelStatus = await sttService.getStatus(localModelKey);
    return {
        sttEngine: config.sttEngine,
        localTier: config.localTier,
        localLanguage: config.localLanguage,
        localModelKey,
        localModel: localModelKey,
        isDownloaded: modelStatus.installed,
        modelAvailable: modelStatus.available,
        modelUnavailableReason: modelStatus.reason,
        modelCachePath: modelsDir,
        autoStopEnabled: !!config.autoStopEnabled,
        autoStopSeconds: typeof config.autoStopSeconds === 'number' ? Math.max(1.5, Math.min(5, config.autoStopSeconds)) : 3.5,
        spacePaste: config.spacePaste === true,
        pasteStyle: config.pasteStyle === 'toast' ? 'toast' : 'bubble',
        pasteKey: typeof config.pasteKey === 'string' && config.pasteKey.length <= 12 ? config.pasteKey : ' ',
        silenceThreshold: typeof config.silenceThreshold === 'number' ? Math.max(2, Math.min(100, config.silenceThreshold)) : 12,
        ecoMode: config.ecoMode !== false,
        alwaysOnTop: typeof config.alwaysOnTop === 'boolean' ? config.alwaysOnTop : true,
        idleFadeEnabled: config.idleFadeEnabled !== false,
        idleOpacity: typeof config.idleOpacity === 'number' ? Math.max(0.1, Math.min(0.9, config.idleOpacity)) : 0.6,
        geminiModel: config.geminiModel || 'gemini-2.5-flash',
        systemRamGB: systemRamGB(),
        recommendedTier: recommendedTierForRam(systemRamGB()),
        playFinishSound: config.playFinishSound !== false
    };
}

async function broadcastSettingsChanged() {
    const snapshot = await getSettingsSnapshot();
    for (const window of [mainWindow, settingsWindow]) {
        if (window && !window.isDestroyed()) window.webContents.send('settings-changed', snapshot);
    }
}

function broadcastModelsChanged() {
    for (const window of [mainWindow, settingsWindow]) {
        if (window && !window.isDestroyed()) window.webContents.send('models-changed');
    }
}

// Get API Key from process.env or saved config
function getApiKeys() {
    const keys = [];
    const envKey = process.env.GEMINI_API_KEY;
    if (envKey && envKey.trim()) keys.push(envKey.trim());
    const config = loadConfig();
    if (config.apiKey && config.apiKey.trim()) keys.push(config.apiKey.trim());
    if (Array.isArray(config.apiKeys)) {
        for (const k of config.apiKeys) {
            if (typeof k === 'string' && k.trim()) keys.push(k.trim());
        }
    }
    return [...new Set(keys)];
}
function getApiKey() { return getApiKeys()[0] || ''; }

function createWindow() {
    const config = loadConfig();

    mainWindow = new BrowserWindow({
        width: 232,
        height: 200,
        x: config.windowX,
        y: config.windowY,
        transparent: true,
        frame: false,
        alwaysOnTop: typeof config.alwaysOnTop === 'boolean' ? config.alwaysOnTop : true,
        resizable: false,
        skipTaskbar: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });

    mainWindow.loadFile('index.html');

    // Click-through transparent areas; renderer re-enables over interactive spots
    mainWindow.setIgnoreMouseEvents(true, { forward: true });

    // Forward renderer console (incl. errors) to app.log
    mainWindow.webContents.on('console-message', (event) => {
        const msg = `[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`;
        console.log(msg);
        logApp(redactLog(msg));
    });

    // Save window position once the drag settles
    let savePosTimer = null;
    mainWindow.on('moved', () => {
        if (!mainWindow) return;
        clearTimeout(savePosTimer);
        savePosTimer = setTimeout(() => {
            const [x, y] = mainWindow.getPosition();
            saveConfig({ windowX: x, windowY: y });
        }, 400);
    });
}

function createSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.show();
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 400,
        height: 700,
        minWidth: 360,
        minHeight: 520,
        parent: mainWindow,
        modal: false,
        title: 'VoiceToClipboard Settings',
        frame: false,
        backgroundColor: '#0e0f14',
        autoHideMenuBar: true,
        resizable: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });

    settingsWindow.loadFile('index.html', { query: { settings: '1' } });
    settingsWindow.on('closed', () => {
        settingsWindow = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('settings-window-closed');
        }
    });
}

function showSettingsWindow() {
    createSettingsWindow();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.show();
        settingsWindow.focus();
    }
}

process.on('uncaughtException', (err) => {
    console.error('MAIN UNCAUGHT:', err);
});

function sanitizeErrorMessage(err) {
    if (!err) return "Unknown error";
    let msg = typeof err === 'string' ? err : (err.message || String(err));
    return msg.replace(/key=[A-Za-z0-9_-]+/gi, 'key=[REDACTED]');
}

function trayMenuForState(alwaysOnTop) {
    return Menu.buildFromTemplate([
        {
            label: '🎙️ Toggle Recording (Ctrl+Alt+V)',
            click: () => {
                if (mainWindow) mainWindow.webContents.send('toggle-recording');
            }
        },
        {
            label: '⚙️ Settings / API Key',
            click: () => showSettingsWindow()
        },
        { type: 'separator' },
        {
            label: '📌 Always on Top',
            type: 'checkbox',
            checked: alwaysOnTop,
            click: item => {
                saveConfig({ alwaysOnTop: item.checked });
                if (mainWindow) mainWindow.setAlwaysOnTop(item.checked);
                if (tray) tray.setContextMenu(trayMenuForState(item.checked));
                broadcastSettingsChanged();
            }
        },
        { type: 'separator' },
        {
            label: '❌ Quit',
            click: () => app.quit()
        }
    ]);
}

function createTray() {
    const iconPath = path.join(__dirname, 'build', 'icon.ico');
    let icon;
    if (fs.existsSync(iconPath)) {
        icon = nativeImage.createFromPath(iconPath);
    } else {
        const iconBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACYSURBVDhPzZExDsMgDEVf6tCld+m+U0+To0TkAhUjy5ZIVUq/xI/tf3ADcM49+oA7Y/5hF5i71oO5G+269wP4jPntA0Tkg1Kq/wNEpAFKqQ9O1wZ8YEqzT9cGTFA3+3RtwAR1s0/XBkxQN/t0bcAER6v26dqACeq2eBtw07X/B1y/G/A13QGk688BpOv/Ac492gE24D70BUt0i16n37dGAAAAAElFTkSuQmCC';
        icon = nativeImage.createFromDataURL('data:image/png;base64,' + iconBase64);
    }
    tray = new Tray(icon);
    tray.setToolTip('VoiceToClipboard (Ctrl+Alt+V)');

    tray.setContextMenu(trayMenuForState(loadConfig().alwaysOnTop !== false));

    const toggleWindow = () => {
        if (mainWindow) {
            if (mainWindow.isVisible()) {
                mainWindow.focus();
            } else {
                mainWindow.show();
            }
        }
    };

    tray.on('click', toggleWindow);
    tray.on('double-click', toggleWindow);
}

let currentHotkeyConfig = null;

function applyHotkeyConfig(hk) {
    if (!hk) {
        currentHotkeyConfig = { type: 'keyboard', keycode: UiohookKey.V, ctrl: true, alt: true, shift: false };
    } else {
        currentHotkeyConfig = hk;
    }
}

uIOhook.on('keydown', (e) => {
    if (mainWindow && mainWindow.webContents && mainWindow.webContents.isFocused()) {
        // let the renderer handle its own keydown if focused and recording? 
        // We moved recording to main process.
    }
    
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
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('toggle-recording');
        }
    }
});

uIOhook.on('mousedown', (e) => {
    if (isRecordingHotkey) {
        if (e.button === 1 && !e.ctrlKey && !e.altKey && !e.shiftKey) return; // Ignore plain left click
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
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('toggle-recording');
        }
    }
});

uIOhook.start();

// ---- Temp-file & trash hygiene ----
// Runs at every startup so nothing in userData can grow without bound:
// stale model caches, leftover download archives, crashpad dumps, oversized
// Electron caches, and old log files are removed.
const MAX_CACHE_BYTES = 200 * 1024 * 1024;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const JUNK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function directorySize(dirPath) {
    let total = 0;
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        try {
            if (entry.isDirectory()) total += await directorySize(full);
            else total += (await fs.promises.stat(full)).size;
        } catch (error) {}
    }
    return total;
}

async function removeOldFiles(dirPath, { olderThanMs = 0, deleteEmptyDirs = false } = {}) {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    const now = Date.now();
    for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        try {
            if (entry.isDirectory()) {
                await removeOldFiles(full, { olderThanMs, deleteEmptyDirs });
                if (deleteEmptyDirs && (await fs.promises.readdir(full).catch(() => [null])).length === 0) {
                    await fs.promises.rmdir(full).catch(() => {});
                }
            } else if (olderThanMs <= 0 || now - (await fs.promises.stat(full)).mtimeMs > olderThanMs) {
                await fs.promises.rm(full, { force: true }).catch(() => {});
            }
        } catch (error) {}
    }
}

async function cleanupJunk() {
    // 1. Model cache: entries no longer in the registry (old per-language models).
    await sttService.cleanupStale();

    // 2. Stray download archives / partial files in the model cache folder.
    const modelEntries = await fs.promises.readdir(modelsDir).catch(() => []);
    for (const name of modelEntries) {
        if (/\.(tar\.bz2|zip|part|tmp|download|aria2)$/i.test(name)) {
            await fs.promises.rm(path.join(modelsDir, name), { recursive: true, force: true }).catch(() => {});
        }
    }

    // 3. Crashpad crash dumps older than a week.
    await removeOldFiles(path.join(canonicalUserDataPath, 'Crashpad'), { olderThanMs: JUNK_AGE_MS, deleteEmptyDirs: true });

    // 4. Electron throwaway caches (recreate on demand) — cap at 200 MB each.
    for (const cacheName of ['Cache', 'Code Cache', 'GPUCache', 'D3DSCache', 'ShaderCache', 'blob_storage']) {
        const cacheDir = path.join(canonicalUserDataPath, cacheName);
        if (!fs.existsSync(cacheDir)) continue;
        try {
            const size = await directorySize(cacheDir);
            if (size > MAX_CACHE_BYTES) {
                await fs.promises.rm(cacheDir, { recursive: true, force: true });
            }
        } catch (error) {}
    }

    // 5. Log files: drop anything older than a week or larger than 5 MB.
    const logEntries = await fs.promises.readdir(canonicalUserDataPath).catch(() => []);
    for (const name of logEntries) {
        if (!/\.(log|txt)$/i.test(name)) continue;
        const full = path.join(canonicalUserDataPath, name);
        try {
            const stat = await fs.promises.stat(full);
            if (stat.isFile() && (Date.now() - stat.mtimeMs > JUNK_AGE_MS || stat.size > MAX_LOG_BYTES)) {
                await fs.promises.rm(full, { force: true });
            }
        } catch (error) {}
    }
}

app.whenReady().then(async () => {
    await migrateLegacyUserData();
    await sttService.prepare();
    await cleanupJunk();
    // Persist any config migration (e.g. per-language -> multilingual) now.
    saveConfig({});
    createWindow();
    createTray();

    const config = loadConfig();
    applyHotkeyConfig(config.customHotkey); // We use customHotkey instead of hotkey to avoid conflict with old format

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('will-quit', () => {
    uIOhook.stop();
    // Do NOT unload native STT models here: vosk-koffi/sherpa-onnx native calls
    // racing with Electron teardown caused koffi.node fail-fast crashes (0xc0000409)
    // on exit. The OS reclaims model memory when the process ends.
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});


// ─── Space-to-paste bubble (v3 prototype) ───────────────────────────────────
// Tracks the last non-widget foreground window, then after a transcription
// shows a tiny bubble near it: SPACE = paste into that window, ESC = dismiss.
const BUBBLE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body { margin:0; font-family:'Segoe UI',sans-serif; background:rgba(22,22,26,0.97); color:#eee; border-radius:12px; overflow:hidden; }
.wrap { padding:16px 22px; box-sizing:border-box; }
.head { font-size:12px; color:#7ee787; font-weight:600; margin-bottom:5px; }
.text { font-size:13px; color:#ddd; max-height:48px; overflow:hidden; word-break:break-word; margin-bottom:9px; line-height:1.35; }
.hint { font-size:12.5px; color:#9aa; white-space:nowrap; }
.hint b { background:rgba(126,231,135,0.16); color:#7ee787; padding:1px 7px; border-radius:5px; font-weight:600; }
.hint .esc { background:rgba(255,255,255,0.08); color:#bbb; padding:1px 7px; border-radius:5px; font-weight:600; }
</style></head><body><div class="wrap">
<div class="head">✓ Transcribed</div>
<div class="text" id="t"></div>
<div class="hint"><b id="key-hint">SPACE</b> to paste</div>
</div><script>
const { ipcRenderer } = require('electron');
const el = document.getElementById('t');
const keyHint = document.getElementById('key-hint');
let pasteKey = ' ';
ipcRenderer.on('bubble-set-text', (e, payload) => {
    const data = (typeof payload === 'string') ? { text: payload } : (payload || {});
    el.textContent = data.text || '';
    if (data.key) pasteKey = data.key;
    if (data.keyLabel) keyHint.textContent = data.keyLabel;
});
window.addEventListener('keydown', (e) => {
    if (e.key === pasteKey || e.key === 'Enter') { e.preventDefault(); ipcRenderer.send('bubble-paste'); }
    else if (e.key === 'Escape') { ipcRenderer.send('bubble-dismiss'); }
});
</script></body></html>`;

let lastExternalHwnd = null;
let bubbleWindow = null;
let bubbleTarget = null;
let bubbleText = '';
let bubbleTimer = null;
let bubblePendingText = '';
let pasteToast = null;

// Remember the window the user was working in (ignores our own widget).
setInterval(() => {
    if (!win32.available) return;
    try {
        if (BrowserWindow.getFocusedWindow()) return; // our own window is focused
        const hwnd = win32.getForegroundWindow();
        if (hwnd) lastExternalHwnd = hwnd;
    } catch (e) { /* ignore polling errors */ }
}, 500);

function ensureBubbleWindow() {
    if (bubbleWindow && !bubbleWindow.isDestroyed()) return;
    bubbleWindow = new BrowserWindow({
        width: 330, height: 98, show: false, frame: false, resizable: false,
        alwaysOnTop: true, skipTaskbar: true, focusable: true, hasShadow: true,
        transparent: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    bubbleWindow.setAlwaysOnTop(true, 'screen-saver');
    bubbleWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(BUBBLE_HTML));
    bubbleWindow.webContents.on('did-finish-load', () => {
        if (bubblePendingText && bubbleWindow && !bubbleWindow.isDestroyed()) {
            const _k = loadConfig().pasteKey || ' ';
            bubbleWindow.webContents.send('bubble-set-text', { text: bubblePendingText, key: _k, keyLabel: _k === ' ' ? 'SPACE' : _k.toUpperCase() });
        }
    });
    bubbleWindow.on('closed', () => { bubbleWindow = null; });
}

function positionBubbleNear(hwnd) {
    const W = 330, H = 98;
    let x = 100, y = 100;
    const rect = win32.getWindowRect(hwnd);
    if (rect && rect.right > rect.left && rect.bottom > rect.top) {
        x = rect.right - W - 28;
        y = rect.bottom - H - 36;
    } else {
        const pt = win32.getCursorPos();
        if (pt) { x = pt.x + 14; y = pt.y + 14; }
    }
    const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - W);
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - H);
    bubbleWindow.setPosition(Math.round(x), Math.round(y));
}

function closePasteBubble() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.destroy();
    bubbleWindow = null;
}

function pasteToTarget(target, text) {
    if (!target || !win32.isWindow(target)) return;
    clipboard.writeText(text);
    win32.setForegroundWindow(target);
    setTimeout(() => win32.sendCtrlV(), 80);
}

function maybeShowPasteToast(text) {
    if (!win32.available) return;
    if (!lastExternalHwnd || !win32.isWindow(lastExternalHwnd)) return;
    const clean = String(text || '').trim();
    if (!clean) return;
    if (pasteToast) { try { pasteToast.close(); } catch (e) { /* ignore */ } }
    const t = new Notification({
        title: '✓ Transcribed',
        body: 'Click to paste into the previous window',
        actions: [{ type: 'button', text: 'Paste' }],
        silent: true
    });
    pasteToast = t;
    t.on('click', () => pasteToTarget(lastExternalHwnd, clean));
    t.on('action', () => pasteToTarget(lastExternalHwnd, clean));
    t.on('close', () => { if (pasteToast === t) pasteToast = null; });
    t.show();
}

function maybeShowPasteBubble(text) {
    if (!win32.available) return;
    if (loadConfig().spacePaste !== true) return;
    if (!lastExternalHwnd || !win32.isWindow(lastExternalHwnd)) return;
    const clean = String(text || '').trim();
    if (!clean) return;
    if (loadConfig().pasteStyle === 'toast') { maybeShowPasteToast(clean); return; }
    bubbleText = clean;
    bubbleTarget = lastExternalHwnd;
    bubblePendingText = clean;
    ensureBubbleWindow();
    if (!bubbleWindow) return;
    positionBubbleNear(bubbleTarget);
    if (bubbleWindow.webContents.isLoading()) {
        // did-finish-load will deliver the text
    } else {
        const _pasteKey = loadConfig().pasteKey || ' ';
            const _keyLabel = _pasteKey === ' ' ? 'SPACE' : _pasteKey.toUpperCase();
            bubbleWindow.webContents.send('bubble-set-text', { text: bubbleText, key: _pasteKey, keyLabel: _keyLabel });
    }
    bubbleWindow.show();
    bubbleWindow.focus();
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(closePasteBubble, 3000);
}

ipcMain.on('bubble-paste', () => {
    const target = bubbleTarget;
    const text = bubbleText;
    closePasteBubble();
    if (!target || !win32.isWindow(target)) return;
    clipboard.writeText(text);
    win32.setForegroundWindow(target);
    setTimeout(() => win32.sendCtrlV(), 80);
});

ipcMain.on('bubble-dismiss', () => closePasteBubble());

// Renderer pushes structured events (transcription results, errors) to app.log
ipcMain.on('renderer-log', (_e, msg) => { logApp(redactLog(msg)); });

// Dev/test helper (opt-in only): VTC_SHOW_BUBBLE=1 shows a sample bubble ~6s after launch.
if (process.env.VTC_SHOW_BUBBLE === '1') {
    setTimeout(() => {
        try { maybeShowPasteBubble('This is your transcribed text. Press SPACE to paste it anywhere.'); } catch (e) { /* ignore */ }
    }, 6000);
}
// ─── end space-to-paste bubble ──────────────────────────────────────────────



// Startup diagnostic — helps debug from app.log (userData dir, works packaged).
{
    const c = loadConfig();
    logApp(`[main] diag-v4 | engine: ${c.sttEngine} | localTier: ${c.localTier || '?'} | model: ${c.localModelKey || '?'} | threshold: ${c.silenceThreshold} | autoStop: ${c.autoStopEnabled} (${c.autoStopSeconds}s) | spacePaste: ${JSON.stringify(c.spacePaste)} | pasteStyle: ${c.pasteStyle || 'bubble'} | pasteKey: ${JSON.stringify(c.pasteKey)} | win32: ${typeof win32 !== 'undefined' && win32.available ? 'yes' : 'no'} | cfg exists: ${fs.existsSync(configPath)}`);
}


const sttService = new SttService({
    modelsDir,
    copyText: text => { clipboard.writeText(text); maybeShowPasteBubble(text); },
    geminiTranscriber: async ({ arrayBuffer, mimeType = 'audio/webm' }) => {
        const keys = getApiKeys();
        if (keys.length === 0) return { success: false, code: 'NO_API_KEY', error: 'GEMINI_API_KEY is not configured.' };

        const buffer = Buffer.from(arrayBuffer);

        const isRateLimitError = (err) => {
            const status = err && (err.status || err.code);
            const msg = (err && (err.message || String(err))) || '';
            return status === 429 || status === 'RESOURCE_EXHAUSTED'
                || /rate.?limit|quota|RESOURCE_EXHAUSTED|429|too many requests|daily/i.test(msg);
        };

        // Rate-limited models AND API keys get a persisted 24h cooldown;
        // both are skipped until they expire (survives app restarts).
        const now = Date.now();
        const pruneCooldowns = (raw) => {
            const cd = { ...(raw || {}) };
            let changed = false;
            for (const [k, until] of Object.entries(cd)) {
                if (until <= now) { delete cd[k]; changed = true; }
            }
            return { cd, changed };
        };
        const { cd: modelCds, changed: mc } = pruneCooldowns(loadConfig().modelCooldowns);
        const { cd: keyCds, changed: kc } = pruneCooldowns(loadConfig().keyCooldowns);
        if (mc || kc) saveConfig({ modelCooldowns: modelCds, keyCooldowns: keyCds });

        // Build the try-chain: preferred model first, then the fixed ladder, minus cooldowns.
        const preferred = loadConfig().geminiModel || 'gemini-2.5-flash';
        const chain = [preferred, ...GEMINI_MODEL_LADDER.filter(m => m !== preferred)]
            .filter(m => !(modelCds[m] && modelCds[m] > now));
        const usableKeys = keys.filter(k => !(keyCds[k] && keyCds[k] > now));

        if (usableKeys.length === 0 || chain.length === 0) {
            const why = usableKeys.length === 0 && chain.length === 0
                ? 'All Gemini API keys and models are rate-limited'
                : usableKeys.length === 0
                    ? 'All Gemini API keys are rate-limited'
                    : 'All Gemini models are rate-limited';
            return { success: false, code: 'RATE_LIMITED', error: `${why} — try again tomorrow.` };
        }

        let lastError = null;
        let usedModel = null;
        const keyRateHits = {}; // distinct-model 429s per key within this run

        outer:
        for (const key of usableKeys) {
            const ai = new GoogleGenAI({ apiKey: key });
            for (const model of chain) {
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        const response = await ai.models.generateContent({
                            model,
                            contents: [
                                { inlineData: { data: buffer.toString('base64'), mimeType } },
                                'Strict speech-to-text. Output ONLY the exact words spoken in the audio, verbatim. Never add, remove, explain, or respond. If there is no speech, output nothing.'
                            ]
                        });
                        const transcript = (response.text ?? '').trim();
                        if (!transcript) {
                            return { success: false, code: 'NO_SPEECH', error: 'No speech detected.' };
                        }
                        usedModel = model;
                        // Model worked: clear any stale cooldowns and remember it as preferred.
                        const cd = { ...(loadConfig().modelCooldowns || {}) };
                        if (cd[model]) { delete cd[model]; saveConfig({ modelCooldowns: cd }); }
                        const kd = { ...(loadConfig().keyCooldowns || {}) };
                        if (kd[key]) { delete kd[key]; saveConfig({ keyCooldowns: kd }); }
                        if (model !== preferred) {
                            saveConfig({ geminiModel: model });
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send('gemini-fallback', model);
                            }
                        }
                        clipboard.writeText(transcript);
                        maybeShowPasteBubble(transcript);
                        return { success: true, text: transcript, model };
                    } catch (error) {
                        lastError = error;
                        console.warn(`Gemini API attempt failed (${model}):`, sanitizeErrorMessage(error));
                        if (isRateLimitError(error)) {
                            // 24h cooldown for this model, move to the next one instantly.
                            const cd = { ...(loadConfig().modelCooldowns || {}) };
                            cd[model] = Date.now() + GEMINI_COOLDOWN_MS;
                            saveConfig({ modelCooldowns: cd });
                            // 2+ distinct-model 429s → this key's daily quota is spent: cool it too.
                            keyRateHits[key] = (keyRateHits[key] || 0) + 1;
                            if (keyRateHits[key] >= 2) {
                                const kd = { ...(loadConfig().keyCooldowns || {}) };
                                kd[key] = Date.now() + GEMINI_COOLDOWN_MS;
                                saveConfig({ keyCooldowns: kd });
                                continue outer;
                            }
                            break;
                        }
                        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 400));
                    }
                }
            }
        }

        return { success: false, code: 'NETWORK_ERROR', error: sanitizeErrorMessage(lastError) };
    }
});

// IPC Handlers
ipcMain.handle('get-api-key-status', () => {
    const envKey = process.env.GEMINI_API_KEY;
    const config = loadConfig();
    const count = getApiKeys().length;
    return {
        hasKey: count > 0,
        count,
        source: (envKey && envKey.trim()) ? 'env' : (config.apiKey || (Array.isArray(config.apiKeys) && config.apiKeys.length) ? 'config' : 'none')
    };
});

ipcMain.handle('get-stt-config', () => getSettingsSnapshot());

ipcMain.handle('get-model-catalog', () => sttService.getCatalog());

ipcMain.handle('save-stt-config', async (event, settings = {}) => {
    const existing = loadConfig();
    const stt = validateSttConfig(settings);
    const effectiveEcoMode = settings.ecoMode !== undefined ? settings.ecoMode !== false : existing.ecoMode !== false;
    const autoStopSeconds = Math.max(1.5, Math.min(5, Number(settings.autoStopSeconds ?? existing.autoStopSeconds) || 3.5));
    const silenceThreshold = Math.max(2, Math.min(100, Number(settings.silenceThreshold ?? existing.silenceThreshold) || 12));
    const idleOpacity = Math.max(0.1, Math.min(0.9, Number(settings.idleOpacity ?? existing.idleOpacity) || 0.6));
    const alwaysOnTop = settings.alwaysOnTop !== undefined ? settings.alwaysOnTop !== false : existing.alwaysOnTop !== false;
    const success = saveConfig({
        ...stt,
        autoStopEnabled: settings.autoStopEnabled !== undefined ? !!settings.autoStopEnabled : !!existing.autoStopEnabled,
        autoStopSeconds,
        silenceThreshold,
        ecoMode: effectiveEcoMode,
        alwaysOnTop,
        idleFadeEnabled: settings.idleFadeEnabled !== undefined ? settings.idleFadeEnabled !== false : existing.idleFadeEnabled !== false,
        idleOpacity,
        geminiModel: settings.geminiModel || existing.geminiModel || 'gemini-2.5-flash',
        spacePaste: settings.spacePaste !== undefined ? !!settings.spacePaste : !!existing.spacePaste,
        pasteStyle: settings.pasteStyle === 'toast' ? 'toast' : (settings.pasteStyle !== undefined ? 'bubble' : (existing.pasteStyle === 'toast' ? 'toast' : 'bubble')),
        pasteKey: typeof settings.pasteKey === 'string' && settings.pasteKey.length > 0 && settings.pasteKey.length <= 12
            ? settings.pasteKey
            : (typeof existing.pasteKey === 'string' && existing.pasteKey.length <= 12 ? existing.pasteKey : ' '),
        playFinishSound: settings.playFinishSound !== undefined ? !!settings.playFinishSound : existing.playFinishSound !== false
    });

    if (!success) return { success: false };
    if (mainWindow) mainWindow.setAlwaysOnTop(alwaysOnTop);
    if (stt.sttEngine !== 'local' || effectiveEcoMode) await sttService.unloadAll();
    if (tray) tray.setContextMenu(trayMenuForState(alwaysOnTop));
    await broadcastSettingsChanged();
    return { success: true };
});

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

let isRecordingHotkey = false;
let hotkeyPromiseResolve = null;

ipcMain.handle('get-hotkey', () => {
    const config = loadConfig();
    return formatHotkey(config.customHotkey);
});

ipcMain.handle('start-recording-hotkey', async () => {
    isRecordingHotkey = true;
    return new Promise((resolve) => {
        hotkeyPromiseResolve = (hk) => {
            applyHotkeyConfig(hk);
            saveConfig({ customHotkey: hk });
            resolve(formatHotkey(hk));
        };
    });
});

ipcMain.handle('check-model-downloaded', async (event, modelKey) => {
    const status = await sttService.getStatus(modelKey);
    return { downloaded: status.installed, available: status.available, reason: status.reason, cachePath: status.cachePath };
});

ipcMain.handle('download-local-model', async (event, modelKey) => {
    const result = await sttService.download(modelKey, data => {
        if (event.sender && !event.sender.isDestroyed()) event.sender.send('download-progress', data);
    });
    if (result.success) broadcastModelsChanged();
    return result;
});

ipcMain.handle('remove-local-model', async (event, modelKey) => {
    const result = await sttService.remove(modelKey);
    broadcastModelsChanged();
    return result;
});

ipcMain.handle('save-api-key', async (event, newKey) => {
    const list = Array.isArray(newKey)
        ? newKey.map(k => String(k || '').trim()).filter(Boolean)
        : [String(newKey || '').trim()].filter(Boolean);
    const success = saveConfig({ apiKey: list[0] || '', apiKeys: list });
    if (success) await broadcastSettingsChanged();
    return { success };
});

ipcMain.handle('remove-api-key', async () => {
    const success = saveConfig({ apiKey: '', apiKeys: [] });
    if (success) await broadcastSettingsChanged();
    return { success };
});

ipcMain.on('show-settings-window', () => {
    showSettingsWindow();
});

ipcMain.on('close-settings-window', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.close();
    }
});

// Custom window drag — absolute positioning. The window target is derived from
// the cursor's SCREEN coordinates (independent of window position), so there is
// no relative-drag feedback loop and the window tracks 1:1 with zero lag.
let dragState = null;

ipcMain.on('drag-start', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [x, y] = mainWindow.getPosition();
    const [w, h] = mainWindow.getSize();
    dragState = {
        winX: x,
        winY: y,
        width: w,
        height: h,
        cursor: screen.getCursorScreenPoint()
    };
});

ipcMain.on('drag-move', () => {
    if (!mainWindow || mainWindow.isDestroyed() || !dragState) return;
    const cursor = screen.getCursorScreenPoint();
    const newX = dragState.winX + (cursor.x - dragState.cursor.x);
    const newY = dragState.winY + (cursor.y - dragState.cursor.y);
    mainWindow.setBounds({
        x: newX,
        y: newY,
        width: dragState.width,
        height: dragState.height
    }, false);
});

ipcMain.on('drag-end', () => {
    dragState = null;
});

// Toggle click-through for transparent areas
ipcMain.on('set-ignore-mouse', (event, ignore) => {
    if (!mainWindow) return;
    mainWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
});

// No periodic timers for topmost: the widget stays a normal always-on-top
// window (a single window style — zero ongoing cost). It only raises itself
// above a fullscreen game the moment the user starts a recording (hotkey or
// click), so there is no background process fighting for the top.
ipcMain.on('widget-raise', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (loadConfig().alwaysOnTop !== false) {
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
        mainWindow.moveTop();
    }
});

// Reliable hover detection. With click-through + forward:true the renderer's
// mouseleave is unreliable, which leaves the top pill visible and blocks the
// idle transparency. Poll the OS cursor against the widget bounds instead.
let lastWidgetHoverState = null;
setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
    const cursor = screen.getCursorScreenPoint();
    const [wx, wy] = mainWindow.getPosition();
    const [ww, wh] = mainWindow.getSize();
    const inside = cursor.x >= wx && cursor.x <= wx + ww && cursor.y >= wy && cursor.y <= wy + wh;
    // Send every tick while inside so the renderer always knows the real cursor
    // position (forwarded mouse events are unreliable under click-through) and
    // can wake the pill immediately on hover.
    if (inside !== lastWidgetHoverState || inside) {
        lastWidgetHoverState = inside;
        mainWindow.webContents.send('widget-hover', inside
            ? { inside: true, x: cursor.x - wx, y: cursor.y - wy }
            : { inside: false });
    }
}, 200);

ipcMain.handle('transcribe-audio', async (event, request) => {
    const config = loadConfig();
    const started = Date.now();
    if (request?.engine === 'local') {
        logApp(`[main] transcribe START | engine: local | model: ${request.modelKey || config.localModelKey} | pcmBytes: ${request.pcm ? request.pcm.byteLength : '?'}`);
        try {
            const r = await sttService.transcribe({
                engine: 'local',
                modelKey: request.modelKey || config.localModelKey,
                pcm: request.pcm,
                sampleRate: request.sampleRate || 16000,
                ecoMode: config.ecoMode !== false
            });
            logApp(`[main] transcribe DONE | engine: local | ok: ${!!r.success} | code: ${r.code || '?'} | ms: ${Date.now() - started}`);
            return r;
        } catch (e) {
            logApp(`[main] transcribe THREW | engine: local | ${String(e && e.stack ? e.stack : e).slice(0, 400)}`);
            return { success: false, code: 'TRANSCRIPTION_ERROR', error: String(e) };
        }
    }
    logApp(`[main] transcribe START | engine: gemini | mime: ${request?.mimeType || '?'}`);
    try {
        const r = await sttService.transcribe({
            engine: 'gemini',
            arrayBuffer: request?.arrayBuffer || request,
            mimeType: request?.mimeType || 'audio/webm'
        });
        logApp(`[main] transcribe DONE | engine: gemini | ok: ${!!r.success} | code: ${r.code || '?'} | ms: ${Date.now() - started}`);
        return r;
    } catch (e) {
        logApp(`[main] transcribe THREW | engine: gemini | ${String(e && e.stack ? e.stack : e).slice(0, 400)}`);
        return { success: false, code: 'TRANSCRIPTION_ERROR', error: String(e) };
    }
});

