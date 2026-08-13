// main.js
// Lean entry point orchestrating Electron lifecycle, subsystems, and window services.

const { app, BrowserWindow, screen } = require('electron');
const { SttService } = require('./stt');
const { logger } = require('./logger');
const { sanitizeErrorMessage } = require('./stt/error-sanitizer');
const {
    canonicalUserDataPath,
    modelsDir,
    loadConfig,
    saveConfig,
    flushConfigImmediately,
    migrateLegacyUserData
} = require('./src/main/config-store');
const { createGeminiTranscriber } = require('./src/main/gemini');
const {
    deliverTranscriptionOutput,
    initForegroundPolling,
    stopForegroundPolling
} = require('./src/main/delivery');
const {
    createMainWindow,
    showSettingsWindow,
    resetWidgetPosition,
    ensureWidgetOnScreen,
    initWidgetHoverPoll,
    stopWidgetHoverPoll,
    broadcastSettingsChanged,
    mainWindow
} = require('./src/main/windows');
const { createTray, updateTrayMenu } = require('./src/main/tray');
const { initHotkeys, stopHotkeys, settleHotkeyCapture } = require('./src/main/hotkeys');
const { cleanupJunk } = require('./src/main/hygiene');
const { registerIpcHandlers } = require('./src/main/ipc');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('js-flags', '--expose-gc --max-old-space-size=256');
app.setAppUserModelId('com.voicetoclipboard.app');
app.setPath('userData', canonicalUserDataPath);
logger.init(canonicalUserDataPath);

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

    const sttService = new SttService({
        modelsDir,
        copyText: text => deliverTranscriptionOutput(text),
        geminiTranscriber: createGeminiTranscriber({
            onFallback: (model) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('gemini-fallback', model);
                }
            },
            onDeliver: (text) => deliverTranscriptionOutput(text)
        })
    });

    const updateTray = () => updateTrayMenu({
        onToggleRecording: () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('toggle-recording');
        },
        onResetPosition: () => resetWidgetPosition(),
        onShowSettings: () => showSettingsWindow({
            onCancelDownloads: () => sttService.cancelAllDownloads(),
            onSettleHotkeys: () => settleHotkeyCapture()
        }),
        onAlwaysOnTopChange: (checked) => {
            saveConfig({ alwaysOnTop: checked });
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(checked);
            updateTray();
            broadcastSettingsChanged(sttService, updateTray);
        },
        onQuit: () => app.quit(),
        onToggleWindow: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                if (mainWindow.isVisible()) mainWindow.focus();
                else mainWindow.show();
            }
        }
    });

    registerIpcHandlers({ sttService, updateTray });

    app.whenReady().then(async () => {
        await migrateLegacyUserData();
        await sttService.prepare();
        await cleanupJunk(sttService);
        saveConfig({});

        const cfg = loadConfig();
        logger.info(`[main] startup | version: ${require('./package.json').version} | engine: ${cfg.sttEngine} | localTier: ${cfg.localTier} | style: ${cfg.widgetStyle} | threshold: ${cfg.silenceThreshold} | autoStop: ${cfg.autoStopEnabled} (${cfg.autoStopSeconds}s) | outputMode: ${cfg.outputMode || 'clipboard'} | uiLang: ${cfg.uiLanguage}`);

        createMainWindow();
        createTray({
            onToggleRecording: () => {
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('toggle-recording');
            },
            onResetPosition: () => resetWidgetPosition(),
            onShowSettings: () => showSettingsWindow({
                onCancelDownloads: () => sttService.cancelAllDownloads(),
                onSettleHotkeys: () => settleHotkeyCapture()
            }),
            onAlwaysOnTopChange: (checked) => {
                saveConfig({ alwaysOnTop: checked });
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(checked);
                updateTray();
                broadcastSettingsChanged(sttService, updateTray);
            },
            onQuit: () => app.quit(),
            onToggleWindow: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    if (mainWindow.isVisible()) mainWindow.focus();
                    else mainWindow.show();
                }
            }
        });

        initHotkeys({
            onToggleRecording: () => {
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('toggle-recording');
            }
        });

        initWidgetHoverPoll();
        initForegroundPolling(() => mainWindow);

        screen.on('display-removed', () => ensureWidgetOnScreen());
        screen.on('display-metrics-changed', () => ensureWidgetOnScreen());

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
        });
    });

    app.on('will-quit', () => {
        flushConfigImmediately();
        stopForegroundPolling();
        stopWidgetHoverPoll();
        stopHotkeys();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    process.on('uncaughtException', (err) => {
        const message = sanitizeErrorMessage(err);
        console.error('MAIN UNCAUGHT:', message);
        logger.error(`[main] uncaught exception | ${message}`);
    });
    process.on('unhandledRejection', (reason) => {
        const message = sanitizeErrorMessage(reason);
        console.error('MAIN UNHANDLED REJECTION:', message);
        logger.error(`[main] unhandled rejection | ${message}`);
    });
}
