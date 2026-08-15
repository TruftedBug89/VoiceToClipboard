// src/main/ipc.js
// Typed IPC handler registration connecting renderer requests to backend subsystems.

const { ipcMain, BrowserWindow, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const {
    loadConfig,
    saveConfig,
    getApiKeys,
    getSettingsSnapshot,
    getUiLanguage,
    getInitialAppearance,
    canonicalUserDataPath
} = require('./config-store');
const {
    listHistory,
    deleteHistory,
    clearHistory,
    exportHistory,
    appendTranscriptionToHistory
} = require('./history-store');
const {
    audioPayloadBytes,
    saveRecordingAudio,
    openRecordingsFolder
} = require('./recordings-store');
const delivery = require('./delivery');
const {
    handleBubblePaste,
    closePasteBubble,
    deliverTranscriptionOutput
} = delivery;
const windows = require('./windows');
const {
    showSettingsWindow,
    closeSettingsWindow,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    broadcastSettingsChanged,
    broadcastModelsChanged
} = windows;
const hotkeys = require('./hotkeys');
const {
    formatHotkey,
    startRecordingHotkey,
    settleHotkeyCapture
} = hotkeys;
const { validateSttConfig, WIDGET_STYLES } = require('../../stt/config');
const { sanitizeErrorMessage } = require('../../stt/error-sanitizer');
const { mapUiLanguage, LOCALES, L } = require('./i18n');
const { cooldownSummary } = require('./gemini');
const { logger } = require('../../logger');
const win32 = require('../../win32');

let lastErrorText = '';

/**
 * Registers all Electron IPC handlers for the main process.
 * @param {object} context
 * @param {import('../../stt').SttService} context.sttService
 * @param {Function} context.updateTray
 */
function registerIpcHandlers({ sttService, updateTray = () => {} }) {
    ipcMain.on('get-initial-appearance', event => {
        event.returnValue = getInitialAppearance();
    });

    // ─── API Key & STT Config ───────────────────────────────────────────────
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

    // Cooldown state for the Gemini failover UI — counts and retry timing
    // only, never key material.
    ipcMain.handle('get-gemini-cooldowns', () => {
        const config = loadConfig();
        const summary = cooldownSummary({ keyCooldowns: config.keyCooldowns, modelCooldowns: config.modelCooldowns });
        return {
            keysActive: summary.keysActive,
            modelsActive: summary.modelsActive,
            nextRetryInSec: Math.ceil(summary.nextRetryInMs / 1000),
            retryInSec: Math.ceil(summary.retryInMs / 1000)
        };
    });

    ipcMain.handle('get-stt-config', () => getSettingsSnapshot(sttService));

    ipcMain.handle('mark-first-run-done', () => {
        saveConfig({ firstRunDone: true });
        return { ok: true };
    });

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
            playFinishSound: settings.playFinishSound !== undefined ? !!settings.playFinishSound : existing.playFinishSound !== false,
            saveRecordings: settings.saveRecordings !== undefined ? !!settings.saveRecordings : existing.saveRecordings === true,
            micDeviceId: typeof settings.micDeviceId === 'string' ? settings.micDeviceId : existing.micDeviceId || '',
            micDeviceLabel: typeof settings.micDeviceLabel === 'string' ? settings.micDeviceLabel : existing.micDeviceLabel || '',
            // History is opt-in. An unrelated settings save must never turn it
            // on merely because an older config omitted the field.
            historyEnabled: settings.historyEnabled !== undefined ? !!settings.historyEnabled : existing.historyEnabled === true,
            historyLimit: typeof settings.historyLimit === 'number' && settings.historyLimit > 0 ? settings.historyLimit : (existing.historyLimit || 50),
            uiLanguage: typeof settings.uiLanguage === 'string' && LOCALES[settings.uiLanguage] ? settings.uiLanguage : (existing.uiLanguage || mapUiLanguage(getUiLanguage())),
            widgetStyle: WIDGET_STYLES.includes(settings.widgetStyle) ? settings.widgetStyle : (WIDGET_STYLES.includes(existing.widgetStyle) ? existing.widgetStyle : 'crimson')
        });

        if (!success) return { success: false };
        if (windows.mainWindow && !windows.mainWindow.isDestroyed()) windows.mainWindow.setAlwaysOnTop(alwaysOnTop);
        if (stt.sttEngine !== 'local' || effectiveEcoMode) await sttService.unloadAll();
        await broadcastSettingsChanged(sttService, updateTray);
        return { success: true };
    });

    // ─── Hotkey Handlers ───────────────────────────────────────────────────
    ipcMain.handle('get-hotkey', () => {
        const config = loadConfig();
        return formatHotkey(config.customHotkey || hotkeys.currentHotkeyConfig);
    });

    ipcMain.handle('start-recording-hotkey', async () => {
        return startRecordingHotkey();
    });

    // ─── Local Model Management ─────────────────────────────────────────────
    ipcMain.handle('check-model-downloaded', async (event, modelKey) => {
        const status = await sttService.getStatus(modelKey);
        return { downloaded: status.installed, available: status.available, reason: status.reason, cachePath: status.cachePath };
    });

    ipcMain.handle('download-local-model', async (event, modelKey) => {
        if (typeof modelKey !== 'string' || !/^[a-z0-9-]{1,64}$/.test(modelKey)) return { success: false, code: 'BAD_MODEL', error: 'Invalid model key.' };
        const result = await sttService.download(modelKey, data => {
            if (event.sender && !event.sender.isDestroyed()) event.sender.send('download-progress', data);
        });
        if (result.success) await broadcastModelsChanged(sttService, updateTray);
        return result;
    });

    ipcMain.handle('remove-local-model', async (event, modelKey) => {
        if (typeof modelKey !== 'string' || !/^[a-z0-9-]{1,64}$/.test(modelKey)) return { success: false, code: 'BAD_MODEL', error: 'Invalid model key.' };
        const result = await sttService.remove(modelKey);
        await broadcastModelsChanged(sttService, updateTray);
        return result;
    });

    ipcMain.handle('cancel-local-model-download', async (event, modelKey) => {
        if (typeof modelKey === 'string' && modelKey) {
            sttService.cancelDownload(modelKey);
        } else {
            sttService.cancelAllDownloads();
        }
        return { success: true };
    });

    // ─── API Key Persistence ────────────────────────────────────────────────
    ipcMain.handle('save-api-key', async (event, newKey) => {
        const list = (Array.isArray(newKey) ? newKey : [newKey])
            .map(k => String(k || '').trim())
            .filter(k => k.length > 0 && k.length <= 512)
            .slice(0, 1);
        const success = saveConfig({ apiKey: list[0] || '', apiKeys: list });
        if (success) await broadcastSettingsChanged(sttService, updateTray);
        return { success };
    });

    ipcMain.handle('remove-api-key', async () => {
        const success = saveConfig({ apiKey: '', apiKeys: [] });
        if (success) await broadcastSettingsChanged(sttService, updateTray);
        return { success };
    });

    // ─── Audio Transcription ────────────────────────────────────────────────
    ipcMain.handle('transcribe-audio', async (event, request) => {
        if (!request || typeof request !== 'object') return { success: false, code: 'BAD_REQUEST', error: 'Invalid transcription request.' };
        const audioBytes = audioPayloadBytes(request);
        if (audioBytes > 62914560) return { success: false, code: 'AUDIO_TOO_LARGE', error: 'Audio payload exceeds size limit.' };
        const savedRecordingPath = await saveRecordingAudio(request);
        const config = loadConfig();
        const started = Date.now();
        const uiLang = request.uiLanguage || getUiLanguage();

        if (request?.engine === 'local') {
            logger.info(`[main] transcribe START | engine: local | model: ${request.modelKey || config.localModelKey} | pcmBytes: ${request.pcm ? request.pcm.byteLength : '?'}`);
            try {
                const r = await sttService.transcribe({
                    engine: 'local',
                    modelKey: request.modelKey || config.localModelKey,
                    pcm: request.pcm,
                    sampleRate: request.sampleRate || 16000,
                    ecoMode: config.ecoMode !== false,
                    uiLanguage: uiLang
                });
                if (!r.success) lastErrorText = `${r.code || 'ERR'}: ${r.error || ''}`;
                else {
                    r.typed = delivery.lastDeliveryTyped;
                    await appendTranscriptionToHistory(r, request, started, savedRecordingPath);
                }
                logger.info(`[main] transcribe DONE | engine: local | ok: ${!!r.success} | code: ${r.code || '?'} | ms: ${Date.now() - started}`);
                return r;
            } catch (e) {
                const message = sanitizeErrorMessage(e);
                lastErrorText = message;
                logger.error(`[main] transcribe THREW | engine: local | ${message.slice(0, 400)}`);
                return { success: false, code: 'TRANSCRIPTION_ERROR', error: message };
            }
        }

        logger.info(`[main] transcribe START | engine: gemini | mime: ${request?.mimeType || '?'}`);
        try {
            const r = await sttService.transcribe({
                engine: 'gemini',
                arrayBuffer: request?.arrayBuffer || request,
                mimeType: request?.mimeType || 'audio/webm',
                uiLanguage: uiLang
            });
            if (!r.success) lastErrorText = `${r.code || 'ERR'}: ${r.error || ''}`;
            else {
                r.typed = delivery.lastDeliveryTyped;
                await appendTranscriptionToHistory(r, request, started, savedRecordingPath);
            }
            logger.info(`[main] transcribe DONE | engine: gemini | ok: ${!!r.success} | code: ${r.code || '?'} | ms: ${Date.now() - started}`);
            return r;
        } catch (e) {
            const message = sanitizeErrorMessage(e);
            lastErrorText = message;
            logger.error(`[main] transcribe THREW | engine: gemini | ${message.slice(0, 400)}`);
            return { success: false, code: 'TRANSCRIPTION_ERROR', error: message };
        }
    });

    // ─── Diagnostics, Recordings & History ──────────────────────────────────
    ipcMain.handle('copy-diagnostics', async () => {
        try {
            const cfg = loadConfig();
            const safe = { ...cfg };
            delete safe.apiKey; delete safe.apiKeys;
            for (const k of Object.keys(safe)) if (/key|token|secret/i.test(k)) safe[k] = '[REDACTED]';
            let tail = '';
            try {
                const logPath = path.join(canonicalUserDataPath, 'app.log');
                if (fs.existsSync(logPath)) {
                    const txt = fs.readFileSync(logPath, 'utf8');
                    tail = txt.split('\n').slice(-40).join('\n');
                }
            } catch (e) {}
            const report = [
                'VoiceToClipboard diagnostics (sanitized)',
                `version: ${require('../../package.json').version}`,
                `platform: ${process.platform} ${process.arch}`,
                `electron: ${process.versions.electron}`,
                `config: ${JSON.stringify(safe, null, 2)}`,
                `lastError: ${sanitizeErrorMessage(lastErrorText || 'none')}`,
                '--- recent app.log tail ---',
                sanitizeErrorMessage(tail),
            ].join('\n');
            clipboard.writeText(sanitizeErrorMessage(report));
            return { success: true };
        } catch (e) {
            return { success: false, code: 'DIAG_FAIL', error: sanitizeErrorMessage(e) };
        }
    });

    ipcMain.handle('open-recordings-folder', () => openRecordingsFolder());

    ipcMain.handle('history-list', (_e, query = '') => listHistory(query));
    ipcMain.handle('history-delete', (_e, id) => deleteHistory(id));
    ipcMain.handle('history-clear', () => clearHistory());
    ipcMain.handle('history-export', (event, format = 'json') => {
        const win = BrowserWindow.fromWebContents(event.sender) || windows.settingsWindow || windows.mainWindow;
        return exportHistory(win, format, (k) => L(k, null, getUiLanguage()));
    });

    ipcMain.handle('paste-text', async (_e, text) => {
        if (typeof text === 'string' && text) {
            clipboard.writeText(text);
            if (win32.available && delivery.lastExternalHwnd && win32.isWindow(delivery.lastExternalHwnd)) {
                win32.setForegroundWindow(delivery.lastExternalHwnd);
                setTimeout(() => win32.sendCtrlV(), 80);
            }
        }
        return { success: true };
    });

    // ─── Fire-and-forget message channels ──────────────────────────────────
    ipcMain.on('bubble-paste', () => handleBubblePaste());
    ipcMain.on('bubble-dismiss', () => closePasteBubble());
    ipcMain.on('renderer-log', (_e, msg) => { logger.info(String(msg).slice(0, 4000)); });
    ipcMain.on('show-settings-window', () => {
        showSettingsWindow();
    });
    ipcMain.on('close-settings-window', () => {
        closeSettingsWindow(() => {
            sttService.cancelAllDownloads();
            settleHotkeyCapture();
        });
    });
    ipcMain.on('drag-start', () => handleDragStart());
    ipcMain.on('drag-move', () => handleDragMove());
    ipcMain.on('drag-end', () => handleDragEnd());
    ipcMain.on('set-ignore-mouse', (event, ignore) => {
        if (!windows.mainWindow || windows.mainWindow.isDestroyed()) return;
        windows.mainWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
    });
    ipcMain.on('widget-raise', () => {
        if (!windows.mainWindow || windows.mainWindow.isDestroyed()) return;
        if (loadConfig().alwaysOnTop !== false) {
            windows.mainWindow.setAlwaysOnTop(true, 'screen-saver');
            windows.mainWindow.moveTop();
        }
    });
}

module.exports = { registerIpcHandlers };
