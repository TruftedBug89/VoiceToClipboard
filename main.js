// main.js
// Lean entry point orchestrating Electron lifecycle, subsystems, and window services.

const { app, BrowserWindow, screen, Menu } = require('electron');
const { SttService } = require('./stt');
const { logger } = require('./logger');
const { sanitizeErrorMessage } = require('./stt/error-sanitizer');
const {
    canonicalUserDataPath,
    modelsDir,
    loadConfig,
    saveConfig,
    flushConfigImmediately,
    migrateLegacyConfig,
    migrateLegacyUserData
} = require('./src/main/config-store');
const { createGeminiTranscriber } = require('./src/main/gemini');
const {
    deliverTranscriptionOutput,
    initForegroundPolling,
    stopForegroundPolling
} = require('./src/main/delivery');
const windows = require('./src/main/windows');
const {
    createMainWindow,
    showSettingsWindow,
    resetWidgetPosition,
    ensureWidgetOnScreen,
    initWidgetHoverPoll,
    stopWidgetHoverPoll,
    broadcastSettingsChanged
} = windows;
const { createTray, updateTrayMenu } = require('./src/main/tray');
const { initHotkeys, stopHotkeys } = require('./src/main/hotkeys');
const { cleanupJunk } = require('./src/main/hygiene');
const { registerIpcHandlers } = require('./src/main/ipc');

app.disableHardwareAcceleration();
// The widget/settings are frameless and never show a menu bar, so drop the
// default application menu entirely — it trims a little main-process memory.
Menu.setApplicationMenu(null);
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
        if (windows.mainWindow) {
            if (windows.mainWindow.isMinimized()) windows.mainWindow.restore();
            windows.mainWindow.focus();
            windows.mainWindow.show();
        }
    });

    const sttService = new SttService({
        modelsDir,
        copyText: text => deliverTranscriptionOutput(text),
        geminiTranscriber: createGeminiTranscriber({
            onFallback: (model) => {
                if (windows.mainWindow && !windows.mainWindow.isDestroyed()) {
                    windows.mainWindow.webContents.send('gemini-fallback', model);
                }
            },
            onDeliver: (text) => deliverTranscriptionOutput(text)
        })
    });

    const updateTray = () => updateTrayMenu({
        onToggleRecording: () => {
            if (windows.mainWindow && !windows.mainWindow.isDestroyed()) windows.mainWindow.webContents.send('toggle-recording');
        },
        onResetPosition: () => resetWidgetPosition(),
        onShowSettings: () => showSettingsWindow(),
        onAlwaysOnTopChange: (checked) => {
            saveConfig({ alwaysOnTop: checked });
            if (windows.mainWindow && !windows.mainWindow.isDestroyed()) windows.mainWindow.setAlwaysOnTop(checked);
            updateTray();
            broadcastSettingsChanged(sttService, updateTray);
        },
        onQuit: () => app.quit(),
        onToggleWindow: () => {
            if (windows.mainWindow && !windows.mainWindow.isDestroyed()) {
                if (windows.mainWindow.isVisible()) windows.mainWindow.focus();
                else windows.mainWindow.show();
            }
        }
    });

    registerIpcHandlers({ sttService, updateTray });

    app.whenReady().then(async () => {
        // Resolve a legacy config before the first default write. This keeps
        // portable/older installs intact and makes first-run detection honest.
        try {
            await migrateLegacyConfig();
        } catch (error) {
            logger.error(`[main] config migration failed | ${sanitizeErrorMessage(error)}`);
        }
        saveConfig({});

        const cfg = loadConfig();
        logger.info(`[main] startup | version: ${require('./package.json').version} | engine: ${cfg.sttEngine} | localTier: ${cfg.localTier} | style: ${cfg.widgetStyle} | threshold: ${cfg.silenceThreshold} | autoStop: ${cfg.autoStopEnabled} (${cfg.autoStopSeconds}s) | outputMode: ${cfg.outputMode || 'clipboard'} | uiLang: ${cfg.uiLanguage}`);

        createMainWindow();
        createTray({
            onToggleRecording: () => {
                if (windows.mainWindow && !windows.mainWindow.isDestroyed()) windows.mainWindow.webContents.send('toggle-recording');
            },
            onResetPosition: () => resetWidgetPosition(),
            onShowSettings: () => showSettingsWindow(),
            onAlwaysOnTopChange: (checked) => {
                saveConfig({ alwaysOnTop: checked });
                if (windows.mainWindow && !windows.mainWindow.isDestroyed()) windows.mainWindow.setAlwaysOnTop(checked);
                updateTray();
                broadcastSettingsChanged(sttService, updateTray);
            },
            onQuit: () => app.quit(),
            onToggleWindow: () => {
                if (windows.mainWindow && !windows.mainWindow.isDestroyed()) {
                    if (windows.mainWindow.isVisible()) windows.mainWindow.focus();
                    else windows.mainWindow.show();
                }
            }
        });

        initHotkeys({
            onToggleRecording: () => {
                if (windows.mainWindow && !windows.mainWindow.isDestroyed()) windows.mainWindow.webContents.send('toggle-recording');
            }
        });

        initWidgetHoverPoll();
        initForegroundPolling(() => windows.mainWindow);

        screen.on('display-removed', () => ensureWidgetOnScreen());
        screen.on('display-metrics-changed', () => ensureWidgetOnScreen());

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
        });

        // Background preparation. Runs AFTER the widget is visible so startup
        // stays fast; each step degrades gracefully and can never block the UI.
        const backgroundPrepare = async () => {
            try {
                // Model-file migration can be substantial, so keep it off the
                // launch path after the config-only migration above.
                await migrateLegacyUserData();
                await sttService.prepare();
                await cleanupJunk(sttService);
            } catch (error) {
                const message = sanitizeErrorMessage(error);
                logger.error(`[main] startup preparation failed | ${message}`);
            }
            await broadcastSettingsChanged(sttService, updateTray);
        };
        backgroundPrepare();
    });

    let isQuitting = false;
    // Shutdown contract: before-quit preventDefaults exactly once, runs the
    // synchronous config flush FIRST, then best-effort async teardown with a
    // 1500ms watchdog. If the native sherpa unload hangs, app.exit(0) kills
    // every child process (GPU/renderers) immediately — no zombie lingering.
    // The isQuitting guard makes the app.quit() inside .finally() re-enter
    // before-quit and fall straight through without preventDefault, so quit
    // can never loop or race window-all-closed.
    app.on('before-quit', (event) => {
        if (isQuitting) return;
        event.preventDefault();
        isQuitting = true;
        flushConfigImmediately();
        stopForegroundPolling();
        stopWidgetHoverPoll();
        stopHotkeys();
        sttService.cancelAllDownloads();
        const shutdownWatchdog = setTimeout(() => {
            logger.error('[main] graceful shutdown stalled for 1500ms — forcing exit (config already flushed)');
            app.exit(0);
        }, 1500);
        sttService.unloadAll()
            .catch(error => logger.error(`[main] shutdown cleanup failed | ${sanitizeErrorMessage(error)}`))
            .finally(() => {
                clearTimeout(shutdownWatchdog);
                app.quit();
            });
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
