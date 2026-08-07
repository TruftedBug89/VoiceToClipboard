const { app, BrowserWindow, ipcMain, clipboard, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { SttService } = require('./stt');
const { migrateConfig, validateSttConfig, systemRamGB, recommendedTierForRam } = require('./stt/config');
const { getModelKey } = require('./stt/model-registry');

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
function getApiKey() {
    const envKey = process.env.GEMINI_API_KEY;
    if (envKey && envKey.trim()) return envKey.trim();
    const config = loadConfig();
    return config.apiKey || '';
}

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
        console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
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

const sttService = new SttService({
    modelsDir,
    copyText: text => clipboard.writeText(text),
    geminiTranscriber: async ({ arrayBuffer, mimeType = 'audio/webm' }) => {
        const apiKey = getApiKey();
        if (!apiKey) return { success: false, code: 'NO_API_KEY', error: 'GEMINI_API_KEY is not configured.' };

        const ai = new GoogleGenAI({ apiKey });
        const buffer = Buffer.from(arrayBuffer);
        let attempts = 0;
        const maxAttempts = 2;
        let lastError = null;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                const response = await ai.models.generateContent({
                    model: loadConfig().geminiModel || 'gemini-2.5-flash',
                    contents: [
                        { inlineData: { data: buffer.toString('base64'), mimeType } },
                        'Transcribe this audio precisely. Return ONLY the transcribed text. Do not add conversational filler or punctuation explanation. Automatically detect the language.'
                    ]
                });
                const transcript = (response.text ?? '').trim();
                if (transcript) {
                    clipboard.writeText(transcript);
                    return { success: true, text: transcript };
                }
                return { success: false, code: 'NO_SPEECH', error: 'No speech detected.' };
            } catch (error) {
                lastError = error;
                console.warn(`Gemini API attempt ${attempts} failed:`, sanitizeErrorMessage(error));
                if (attempts < maxAttempts) await new Promise(resolve => setTimeout(resolve, 400));
            }
        }

        return { success: false, code: 'NETWORK_ERROR', error: sanitizeErrorMessage(lastError) };
    }
});

// IPC Handlers
ipcMain.handle('get-api-key-status', () => {
    const envKey = process.env.GEMINI_API_KEY;
    const config = loadConfig();
    return {
        hasKey: !!((envKey && envKey.trim()) || config.apiKey),
        source: (envKey && envKey.trim()) ? 'env' : (config.apiKey ? 'config' : 'none')
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
    const success = saveConfig({ apiKey: newKey.trim() });
    if (success) await broadcastSettingsChanged();
    return { success };
});

ipcMain.handle('remove-api-key', async () => {
    const success = saveConfig({ apiKey: '' });
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
    if (request?.engine === 'local') {
        return sttService.transcribe({
            engine: 'local',
            modelKey: request.modelKey || config.localModelKey,
            pcm: request.pcm,
            sampleRate: request.sampleRate || 16000,
            ecoMode: config.ecoMode !== false
        });
    }
    return sttService.transcribe({
        engine: 'gemini',
        arrayBuffer: request?.arrayBuffer || request,
        mimeType: request?.mimeType || 'audio/webm'
    });
});

