// src/main/windows.js
// Window lifecycle management (widget, settings), screen boundary clamping, and click-through hover polling.

const { BrowserWindow, screen, shell } = require('electron');
const path = require('path');
const { loadConfig, saveConfig, getSettingsSnapshot, getUiLanguage } = require('./config-store');
const { L } = require('./i18n');
const { sanitizeErrorMessage } = require('../../stt/error-sanitizer');
const { logger } = require('../../logger');

let mainWindow = null;
let settingsWindow = null;
let dragState = null;
let widgetHoverPoll = null;
let lastWidgetHoverState = null;
let lastWidgetCursorX = null;
let lastWidgetCursorY = null;

function secureWebContents(webContents) {
    webContents.setWindowOpenHandler(({ url }) => {
        if (url === 'https://aistudio.google.com/apikey') shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
    });
    webContents.on('will-navigate', (event, url) => {
        if (url !== webContents.getURL()) event.preventDefault();
    });
}

function ensureWidgetAlwaysOnTop() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (loadConfig().alwaysOnTop === false) return;
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
}

function resetWidgetPosition() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const primaryArea = screen.getPrimaryDisplay().workArea;
    const [ww, wh] = mainWindow.getSize();
    const x = Math.round(primaryArea.x + (primaryArea.width - ww) / 2);
    const y = Math.round(primaryArea.y + (primaryArea.height - wh) / 2);
    mainWindow.setPosition(x, y);
    saveConfig({ windowX: x, windowY: y });
}

function ensureWidgetOnScreen() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const displays = screen.getAllDisplays();
    const [wx, wy] = mainWindow.getPosition();
    const [ww, wh] = mainWindow.getSize();
    const intersects = displays.some(d => {
        const wa = d.workArea;
        return (wx + ww > wa.x + 20 && wx < wa.x + wa.width - 20 &&
                wy + wh > wa.y + 20 && wy < wa.y + wa.height - 20);
    });
    if (!intersects) {
        resetWidgetPosition();
    }
}

function createMainWindow() {
    const config = loadConfig();
    let windowX = config.windowX;
    let windowY = config.windowY;
    const displays = screen.getAllDisplays();
    const isValid = typeof windowX === 'number' && typeof windowY === 'number' && displays.some(d => {
        const wa = d.workArea;
        return (windowX + 232 > wa.x + 20 && windowX < wa.x + wa.width - 20 &&
                windowY + 200 > wa.y + 20 && windowY < wa.y + wa.height - 20);
    });
    if (!isValid) {
        const primaryArea = screen.getPrimaryDisplay().workArea;
        windowX = Math.round(primaryArea.x + (primaryArea.width - 232) / 2);
        windowY = Math.round(primaryArea.y + (primaryArea.height - 200) / 2);
    }

    mainWindow = new BrowserWindow({
        width: 232,
        height: 200,
        x: windowX,
        y: windowY,
        transparent: true,
        frame: false,
        alwaysOnTop: typeof config.alwaysOnTop === 'boolean' ? config.alwaysOnTop : true,
        resizable: false,
        skipTaskbar: false,
        webPreferences: {
            preload: path.join(__dirname, '../../preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            backgroundThrottling: false
        }
    });

    secureWebContents(mainWindow.webContents);
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.loadFile(path.join(__dirname, '../../index.html'));

    mainWindow.setIgnoreMouseEvents(true, { forward: true });

    mainWindow.webContents.on('console-message', (event, level, message, lineNumber, sourceId) => {
        const lvl = typeof level === 'number' || typeof level === 'string' ? level : (event && event.level);
        const msgText = typeof message === 'string' ? message : (event && event.message);
        const line = typeof lineNumber === 'number' || typeof lineNumber === 'string' ? lineNumber : (event && event.lineNumber);
        const src = typeof sourceId === 'string' ? sourceId : (event && event.sourceId);
        const msg = `[renderer:${lvl}] ${msgText} (${src}:${line})`;
        logger.info(msg);
    });

    let savePosTimer = null;
    mainWindow.on('moved', () => {
        if (!mainWindow) return;
        clearTimeout(savePosTimer);
        savePosTimer = setTimeout(() => {
            const [x, y] = mainWindow.getPosition();
            saveConfig({ windowX: x, windowY: y });
            ensureWidgetAlwaysOnTop();
        }, 400);
    });

    ensureWidgetAlwaysOnTop();
    return mainWindow;
}

function createSettingsWindow({ onCancelDownloads = () => {}, onSettleHotkeys = () => {} } = {}) {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.show();
        settingsWindow.focus();
        return settingsWindow;
    }

    const lang = getUiLanguage();
    settingsWindow = new BrowserWindow({
        width: 400,
        height: 700,
        minWidth: 360,
        minHeight: 520,
        parent: mainWindow,
        modal: false,
        title: L('settingsWindow.title', null, lang),
        frame: false,
        backgroundColor: '#0e0f14',
        autoHideMenuBar: true,
        resizable: true,
        webPreferences: {
            preload: path.join(__dirname, '../../preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            backgroundThrottling: true
        }
    });

    secureWebContents(settingsWindow.webContents);
    settingsWindow.loadFile(path.join(__dirname, '../../index.html'), { query: { settings: '1' } });
    settingsWindow.on('closed', () => {
        onCancelDownloads();
        onSettleHotkeys();
        settingsWindow = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('settings-window-closed');
        }
        ensureWidgetAlwaysOnTop();
    });

    return settingsWindow;
}

function showSettingsWindow(callbacks) {
    createSettingsWindow(callbacks);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.show();
        settingsWindow.focus();
    }
    ensureWidgetAlwaysOnTop();
}

function closeSettingsWindow(onCancelDownloads) {
    if (onCancelDownloads) onCancelDownloads();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.close();
    }
}

function initWidgetHoverPoll() {
    if (widgetHoverPoll) clearInterval(widgetHoverPoll);
    widgetHoverPoll = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
        const cursor = screen.getCursorScreenPoint();
        const [wx, wy] = mainWindow.getPosition();
        const [ww, wh] = mainWindow.getSize();
        const inside = cursor.x >= wx && cursor.x <= wx + ww && cursor.y >= wy && cursor.y <= wy + wh;
        const relX = inside ? cursor.x - wx : 0;
        const relY = inside ? cursor.y - wy : 0;
        if (inside !== lastWidgetHoverState || (inside && (relX !== lastWidgetCursorX || relY !== lastWidgetCursorY))) {
            lastWidgetHoverState = inside;
            lastWidgetCursorX = relX;
            lastWidgetCursorY = relY;
            if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send('widget-hover', inside
                    ? { inside: true, x: relX, y: relY }
                    : { inside: false });
            }
        }
    }, 200);
}

function stopWidgetHoverPoll() {
    if (widgetHoverPoll) {
        clearInterval(widgetHoverPoll);
        widgetHoverPoll = null;
    }
}

function handleDragStart() {
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
}

function handleDragMove() {
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
}

function handleDragEnd() {
    dragState = null;
    ensureWidgetAlwaysOnTop();
}

async function broadcastSettingsChanged(sttService, updateTray) {
    if (updateTray) updateTray();
    const snapshot = await getSettingsSnapshot(sttService);
    for (const window of [mainWindow, settingsWindow]) {
        if (window && !window.isDestroyed()) window.webContents.send('settings-changed', snapshot);
    }
}

async function broadcastModelsChanged(sttService, updateTray) {
    await broadcastSettingsChanged(sttService, updateTray);
    for (const window of [mainWindow, settingsWindow]) {
        if (window && !window.isDestroyed()) window.webContents.send('models-changed');
    }
}

module.exports = {
    get mainWindow() { return mainWindow; },
    get settingsWindow() { return settingsWindow; },
    createMainWindow,
    createSettingsWindow,
    showSettingsWindow,
    closeSettingsWindow,
    resetWidgetPosition,
    ensureWidgetOnScreen,
    ensureWidgetAlwaysOnTop,
    initWidgetHoverPoll,
    stopWidgetHoverPoll,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    broadcastSettingsChanged,
    broadcastModelsChanged
};
