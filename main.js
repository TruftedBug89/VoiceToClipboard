const { app, BrowserWindow, ipcMain, clipboard, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const reverseKeyMap = Object.entries(UiohookKey).reduce((acc, [k, v]) => { acc[v] = k; return acc; }, {});

app.disableHardwareAcceleration();
// Windows App User Model ID — required before windows are created so the
// taskbar groups the app correctly and pinning the icon works properly.
app.setAppUserModelId('com.voicetoclipboard.app');

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
const configPath = path.join(app.getPath('userData'), 'config.json');

// Helper to load config
function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) {
        console.error("Failed to load config:", e);
    }
    return {};
}

// Helper to save config
function saveConfig(data) {
    try {
        const config = { ...loadConfig(), ...data };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error("Failed to save config:", e);
        return false;
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
        width: 220,
        height: 130,
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
        width: 360,
        height: 680,
        minWidth: 320,
        minHeight: 480,
        parent: mainWindow,
        modal: false,
        title: 'VoiceToClipboard Settings',
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

    const contextMenu = Menu.buildFromTemplate([
        { 
            label: '🎙️ Toggle Recording (Ctrl+Alt+V)', 
            click: () => {
                if (mainWindow) mainWindow.webContents.send('toggle-recording');
            } 
        },
        { 
            label: '⚙️ Settings / API Key', 
            click: () => {
                showSettingsWindow();
            } 
        },
        { type: 'separator' },
        { 
            label: '📌 Always on Top', 
            type: 'checkbox', 
            checked: typeof loadConfig().alwaysOnTop === 'boolean' ? loadConfig().alwaysOnTop : true, 
            click: (item) => {
                const cfg = loadConfig();
                cfg.alwaysOnTop = item.checked;
                saveConfig({ alwaysOnTop: item.checked });
                if (mainWindow) mainWindow.setAlwaysOnTop(item.checked);
                if (mainWindow) mainWindow.webContents.send('sync-settings');
            } 
        },
        { type: 'separator' },
        { 
            label: '❌ Quit', 
            click: () => {
                app.quit();
            } 
        }
    ]);

    tray.setContextMenu(contextMenu);

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

app.whenReady().then(() => {
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
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Local Transformers.js / Whisper setup
let pipelineFn = null;
const modelsDir = path.join(app.getPath('userData'), 'models');
if (!fs.existsSync(modelsDir)) {
    try { fs.mkdirSync(modelsDir, { recursive: true }); } catch (e) {}
}

async function getPipelineModule() {
    if (!pipelineFn) {
        const { pipeline, env } = require('@xenova/transformers');
        env.cacheDir = modelsDir;
        if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
            env.backends.onnx.wasm.numThreads = 1;
        }
        pipelineFn = pipeline;
    }
    return pipelineFn;
}

let transcriberCache = null;
let loadedModelId = null;

function unloadLocalModel() {
    if (transcriberCache && typeof transcriberCache.dispose === 'function') {
        transcriberCache.dispose();
    }
    transcriberCache = null;
    loadedModelId = null;
}

async function getTranscriber(modelId, progressCallback) {
    const pipeline = await getPipelineModule();
    if (transcriberCache && loadedModelId === modelId) {
        return transcriberCache;
    }
    if (transcriberCache) {
        unloadLocalModel();
    }
    transcriberCache = await pipeline('automatic-speech-recognition', modelId, {
        progress_callback: progressCallback
    });
    loadedModelId = modelId;
    return transcriberCache;
}

function isModelDownloaded(modelId) {
    const sanitizeName = modelId.replace('/', '--');
    const folder1 = path.join(modelsDir, `models--${sanitizeName}`);
    const folder2 = path.join(modelsDir, modelId);
    return fs.existsSync(folder1) || fs.existsSync(folder2);
}

// IPC Handlers
ipcMain.handle('get-api-key-status', () => {
    const envKey = process.env.GEMINI_API_KEY;
    const config = loadConfig();
    return {
        hasKey: !!((envKey && envKey.trim()) || config.apiKey),
        source: (envKey && envKey.trim()) ? 'env' : (config.apiKey ? 'config' : 'none')
    };
});

ipcMain.handle('get-stt-config', () => {
    const config = loadConfig();
    return {
        sttEngine: config.sttEngine || 'gemini',
        localModel: config.localModel || 'Xenova/whisper-base',
        isDownloaded: isModelDownloaded(config.localModel || 'Xenova/whisper-base'),
        autoStopEnabled: !!config.autoStopEnabled,
        autoStopSeconds: typeof config.autoStopSeconds === 'number' ? config.autoStopSeconds : 3.5,
        silenceThreshold: typeof config.silenceThreshold === 'number' ? config.silenceThreshold : 12,
        ecoMode: config.ecoMode !== false,
        alwaysOnTop: typeof config.alwaysOnTop === 'boolean' ? config.alwaysOnTop : true,
        idleFadeEnabled: !!config.idleFadeEnabled,
        idleOpacity: typeof config.idleOpacity === 'number' ? config.idleOpacity : 0.6
    };
});

ipcMain.handle('save-stt-config', (event, { sttEngine, localModel, autoStopEnabled, autoStopSeconds, silenceThreshold, ecoMode, alwaysOnTop, idleFadeEnabled, idleOpacity }) => {
    const effectiveEcoMode = ecoMode !== false;
    const success = saveConfig({ sttEngine, localModel, autoStopEnabled, autoStopSeconds, silenceThreshold, ecoMode: effectiveEcoMode, alwaysOnTop, idleFadeEnabled, idleOpacity });
    
    if (mainWindow) mainWindow.setAlwaysOnTop(alwaysOnTop);

    if (sttEngine !== 'local' || effectiveEcoMode || loadedModelId !== localModel) {
        unloadLocalModel();
    }
    
    // Update tray checkbox
    if (tray) {
        const menu = tray.ContextMenu || Menu.buildFromTemplate([ ...tray.getContextMenu().items.map(i => {
            if (i.label === '📌 Always on Top') i.checked = alwaysOnTop;
            return i;
        }) ]);
        tray.setContextMenu(menu);
    }

    return { success };
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

ipcMain.handle('check-model-downloaded', (event, modelId) => {
    return { downloaded: isModelDownloaded(modelId) };
});

ipcMain.handle('download-local-model', async (event, modelId) => {
    try {
        await getTranscriber(modelId, (data) => {
            if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('download-progress', data);
            }
        });
        return { success: true };
    } catch (err) {
        console.error("Model download error:", err);
        return { success: false, error: err.message };
    }
});



ipcMain.handle('save-api-key', (event, newKey) => {
    const success = saveConfig({ apiKey: newKey.trim() });
    return { success };
});

ipcMain.handle('remove-api-key', () => {
    const success = saveConfig({ apiKey: '' });
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

ipcMain.handle('transcribe-audio', async (event, arrayBuffer) => {
    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: "GEMINI_API_KEY is not configured." };
    }

    const ai = new GoogleGenAI({ apiKey });
    const buffer = Buffer.from(arrayBuffer);

    let attempts = 0;
    const maxAttempts = 2;
    let lastError = null;

    while (attempts < maxAttempts) {
        attempts++;
        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [
                    {
                        inlineData: {
                            data: buffer.toString("base64"),
                            mimeType: "audio/webm"
                        }
                    },
                    "Transcribe this audio precisely. Return ONLY the transcribed text. Do not add conversational filler or punctuation explanation. Automatically detect the language."
                ]
            });

            const transcript = (response.text ?? '').trim();

            if (transcript) {
                clipboard.writeText(transcript);
                return { success: true, text: transcript };
            } else {
                return { success: false, error: "No speech detected." };
            }
        } catch (error) {
            lastError = error;
            console.warn(`Gemini API attempt ${attempts} failed:`, sanitizeErrorMessage(error));
            if (attempts < maxAttempts) {
                await new Promise(r => setTimeout(r, 400));
            }
        }
    }

    const cleanMsg = sanitizeErrorMessage(lastError);
    console.error("Transcription error (after retry):", cleanMsg);
    return { success: false, error: cleanMsg };
});

function cleanWhisperHallucinations(text) {
    if (!text) return '';
    let cleaned = text;
    // Remove repeated single words (3 or more consecutive repetitions, e.g. "The The The The")
    cleaned = cleaned.replace(/(\b\w+\b)(?:\s+\1){2,}/gi, '$1');
    // Remove repeated 2-word phrases (2 or more consecutive repetitions)
    cleaned = cleaned.replace(/(\b\w+\s+\w+\b)(?:\s+\1){2,}/gi, '$1');
    // Remove repeated 3-word phrases
    cleaned = cleaned.replace(/(\b\w+\s+\w+\s+\w+\b)(?:\s+\1){2,}/gi, '$1');
    return cleaned.trim();
}

ipcMain.handle('transcribe-audio-local', async (event, float32Buffer) => {
    try {
        const config = loadConfig();
        const modelId = config.localModel || 'Xenova/whisper-base';

        if (!isModelDownloaded(modelId)) {
            return { success: false, error: "Model weights not downloaded yet." };
        }

        const transcriber = await getTranscriber(modelId);
        const float32Array = new Float32Array(
            float32Buffer.buffer,
            float32Buffer.byteOffset,
            float32Buffer.byteLength / 4
        );

        const output = await transcriber(float32Array, {
            task: 'transcribe',
            return_timestamps: false,
            chunk_length_s: 30,
            stride_length_s: 5,
            repetition_penalty: 1.2,
            no_repeat_ngram_size: 3,
            condition_on_previous_text: false
        });

        const rawText = (output && output.text ? output.text : '').trim();
        const transcript = cleanWhisperHallucinations(rawText);

        if (config.ecoMode !== false) {
            unloadLocalModel();
        }

        if (transcript) {
            clipboard.writeText(transcript);
            return { success: true, text: transcript };
        } else {
            return { success: false, error: "No speech detected." };
        }
    } catch (error) {
        console.error("Local Whisper transcription error:", error);
        if (loadConfig().ecoMode) {
            unloadLocalModel();
        }
        return { success: false, error: error.message };
    }
});

