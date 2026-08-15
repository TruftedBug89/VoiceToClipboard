// src/main/windows.js
// Window lifecycle management (widget, settings), screen boundary clamping, and click-through hover polling.

const { BrowserWindow, screen, shell } = require('electron');
const path = require('path');
const { loadConfig, saveConfig, getSettingsSnapshot } = require('./config-store');
const { sanitizeErrorMessage } = require('../../stt/error-sanitizer');
const { logger } = require('../../logger');

let mainWindow = null;
let settingsWindow = null;
let dragState = null;
let widgetHoverPoll = null;
let lastWidgetHoverState = null;
let lastWidgetNearState = null;
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
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        return mainWindow;
    }
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
            backgroundThrottling: true
        }
    });

    secureWebContents(mainWindow.webContents);
    mainWindow.on('closed', () => {
        mainWindow = null;
        settingsRestoreBounds = null;
        settingsExpanded = false;
    });
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
        if (settingsExpanded) return;
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

// Settings live in their own frameless window (index.html?settings=1), so
// the widget keeps its tiny always-on-top footprint while settings get a
// full, resizable surface.
function createSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.show();
        settingsWindow.focus();
        return settingsWindow;
    }
    settingsWindow = new BrowserWindow({
        width: 420,
        height: 720,
        minWidth: 360,
        minHeight: 520,
        parent: mainWindow,
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
        settingsWindow = null;
        ensureWidgetAlwaysOnTop();
    });
    return settingsWindow;
}

function showSettingsWindow() {
    const win = createSettingsWindow();
    if (win) {
        win.show();
        win.focus();
    }
    ensureWidgetAlwaysOnTop();
    return win;
}

function closeSettingsWindow(onCancelDownloads) {
    if (onCancelDownloads) onCancelDownloads();
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    ensureWidgetAlwaysOnTop();
}

// Hysteresis margin for the click-through hover poll: once the cursor has left
// the window rect, it stays "near" until it is this many px outside. 16px ≈ one
// 200ms poll step at a slow (~80px/s) cursor, which kills the enter/leave
// oscillation at the widget edge without making the dead zone feel sticky.
const WIDGET_HOVER_HYSTERESIS_PX = 16;

function initWidgetHoverPoll() {
    if (widgetHoverPoll) clearInterval(widgetHoverPoll);
    // A fresh renderer must receive its first hover state even when the poll
    // was stopped and restarted while the pointer did not move.
    lastWidgetHoverState = null;
    lastWidgetNearState = null;
    lastWidgetCursorX = null;
    lastWidgetCursorY = null;
    widgetHoverPoll = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
        const cursor = screen.getCursorScreenPoint();
        const [wx, wy] = mainWindow.getPosition();
        const [ww, wh] = mainWindow.getSize();
        const inside = cursor.x >= wx && cursor.x <= wx + ww && cursor.y >= wy && cursor.y <= wy + wh;
        // "near" covers the hysteresis band just outside the rect; the renderer
        // holds its current interactive state while near so the ignore flag
        // can't flap when the cursor grazes the edge.
        const near = cursor.x >= wx - WIDGET_HOVER_HYSTERESIS_PX && cursor.x <= wx + ww + WIDGET_HOVER_HYSTERESIS_PX &&
            cursor.y >= wy - WIDGET_HOVER_HYSTERESIS_PX && cursor.y <= wy + wh + WIDGET_HOVER_HYSTERESIS_PX;
        const relX = inside ? cursor.x - wx : 0;
        const relY = inside ? cursor.y - wy : 0;
        const stateChanged = inside !== lastWidgetHoverState || near !== lastWidgetNearState;
        if (stateChanged || (inside && (relX !== lastWidgetCursorX || relY !== lastWidgetCursorY))) {
            lastWidgetHoverState = inside;
            lastWidgetNearState = near;
            lastWidgetCursorX = relX;
            lastWidgetCursorY = relY;
            if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send('widget-hover', inside
                    ? { inside: true, x: relX, y: relY, near: true }
                    : { inside: false, near });
            }
        }
    }, 200);
}

function stopWidgetHoverPoll() {
    if (widgetHoverPoll) {
        clearInterval(widgetHoverPoll);
        widgetHoverPoll = null;
    }
    lastWidgetHoverState = null;
    lastWidgetNearState = null;
    lastWidgetCursorX = null;
    lastWidgetCursorY = null;
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
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings-changed', snapshot);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('settings-changed', snapshot);
}

async function broadcastModelsChanged(sttService, updateTray) {
    await broadcastSettingsChanged(sttService, updateTray);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('models-changed');
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('models-changed');
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
