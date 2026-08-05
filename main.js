const { app, BrowserWindow, ipcMain, clipboard, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

app.disableHardwareAcceleration();

let mainWindow;
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
        alwaysOnTop: true,
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

process.on('uncaughtException', (err) => {
    console.error('MAIN UNCAUGHT:', err);
});

function createTray() {
    // Generate a simple 16x16 red/gray circle icon for tray
    const svgIcon = `
    <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="6" fill="#e63946"/>
        <path d="M8 4v5M6 7l2 2 2-2" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    
    const icon = nativeImage.createFromBuffer(Buffer.from(svgIcon));
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
                if (mainWindow) mainWindow.webContents.send('open-settings');
            } 
        },
        { type: 'separator' },
        { 
            label: '📌 Always on Top', 
            type: 'checkbox', 
            checked: true, 
            click: (item) => {
                if (mainWindow) mainWindow.setAlwaysOnTop(item.checked);
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
    tray.on('double-click', () => {
        if (mainWindow) {
            if (mainWindow.isVisible()) {
                mainWindow.focus();
            } else {
                mainWindow.show();
            }
        }
    });
}

app.whenReady().then(() => {
    createWindow();
    createTray();

    // Register Global Shortcut
    const registered = globalShortcut.register('CommandOrControl+Alt+V', () => {
        if (mainWindow) {
            mainWindow.webContents.send('toggle-recording');
        }
    });

    if (!registered) {
        console.warn('Global shortcut registration failed!');
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC Handlers
ipcMain.handle('get-api-key-status', () => {
    const key = getApiKey();
    return { hasKey: !!key, key: key ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : '' };
});

ipcMain.handle('save-api-key', (event, newKey) => {
    const success = saveConfig({ apiKey: newKey.trim() });
    return { success };
});

// Custom window drag (hold + move on the mic/subtitles; never triggers recording)
ipcMain.on('drag-window', (event, dx, dy) => {
    if (!mainWindow) return;
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x + dx, y + dy);
});

// Toggle click-through for transparent areas
ipcMain.on('set-ignore-mouse', (event, ignore) => {
    if (!mainWindow) return;
    mainWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.handle('transcribe-audio', async (event, arrayBuffer) => {
    try {
        const apiKey = getApiKey();
        if (!apiKey) {
            return { success: false, error: "GEMINI_API_KEY is not configured." };
        }

        const ai = new GoogleGenAI({ apiKey });
        const buffer = Buffer.from(arrayBuffer);

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
        console.error("Transcription error:", error);
        return { success: false, error: error.message };
    }
});
