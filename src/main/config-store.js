const electron = require('electron');
const app = electron.app;
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { migrateConfig, validateSttConfig, systemRamGB, recommendedTierForRam, WIDGET_STYLES } = require('../../stt/config');
const { getModelKey } = require('../../stt/model-registry');
const { mapUiLanguage, LOCALES } = require('./i18n');

function getAppDataRoot() {
    if (app && typeof app.getPath === 'function') {
        try { return app.getPath('appData'); } catch (e) {}
    }
    return process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
}

function getSystemLocale() {
    if (app && typeof app.getLocale === 'function') {
        try { return app.getLocale(); } catch (e) {}
    }
    return 'en';
}

// Portable mode support: if PORTABLE_EXECUTABLE_DIR is set, place data next to executable
let canonicalUserDataPath;
if (process.env.PORTABLE_EXECUTABLE_DIR && typeof process.env.PORTABLE_EXECUTABLE_DIR === 'string') {
    canonicalUserDataPath = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
} else {
    canonicalUserDataPath = path.join(getAppDataRoot(), 'VoiceToClipboard');
}

const configPath = path.join(canonicalUserDataPath, 'config.json');
const modelsDir = path.join(canonicalUserDataPath, 'models');
const recordingsDir = path.join(canonicalUserDataPath, 'recordings');
const historyPath = path.join(canonicalUserDataPath, 'history.json');

const legacyUserDataPaths = [
    path.join(getAppDataRoot(), 'voicetoclipboard')
];

let cachedConfig = null;
let writeQueue = Promise.resolve();
let saveDebounceTimer = null;

// Captured before main.js calls saveConfig({}) during boot. A legacy config
// also means this is an existing user: migrate it before the first write and
// never re-show the welcome tour just because its data location changed.
const configFileExistedAtBoot = fs.existsSync(configPath)
    || legacyUserDataPaths.some(legacyPath => fs.existsSync(path.join(legacyPath, 'config.json')));

async function migrateLegacyConfig() {
    await fs.promises.mkdir(canonicalUserDataPath, { recursive: true });
    for (const legacyPath of legacyUserDataPaths) {
        if (path.resolve(legacyPath) === path.resolve(canonicalUserDataPath) || !fs.existsSync(legacyPath)) continue;
        const legacyConfigPath = path.join(legacyPath, 'config.json');
        if (!fs.existsSync(configPath) && fs.existsSync(legacyConfigPath)) {
            await fs.promises.copyFile(legacyConfigPath, configPath);
        }
    }
}

async function migrateLegacyUserData() {
    await migrateLegacyConfig();
    for (const legacyPath of legacyUserDataPaths) {
        if (path.resolve(legacyPath) === path.resolve(canonicalUserDataPath) || !fs.existsSync(legacyPath)) continue;

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

// Monotonic write generation. Each scheduled async write captures the
// current generation; flushConfigImmediately bumps it so an older snapshot
// still queued or in flight is skipped instead of renaming over the
// fresher synchronous flush (last-writer-wins corruption guard).
let writeGeneration = 0;

async function performWriteToDisk(configToWrite, generation) {
    const tempPath = `${configPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    let renamed = false;
    try {
        await fs.promises.writeFile(tempPath, JSON.stringify(configToWrite, null, 2), 'utf8');
        // Re-check AFTER writing: a synchronous flush may have superseded
        // this snapshot while the bytes were hitting disk.
        if (generation === writeGeneration) {
            await fs.promises.rename(tempPath, configPath);
            renamed = true;
        }
    } catch (e) {
        console.error('Failed to save config asynchronously:', e.message || e);
    } finally {
        if (!renamed) {
            try { await fs.promises.unlink(tempPath); } catch (e) { /* ignore */ }
        }
    }
}

function scheduleDiskWrite() {
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => {
        saveDebounceTimer = null;
        const configSnapshot = { ...loadConfig() };
        const generation = writeGeneration;
        writeQueue = writeQueue.then(() => performWriteToDisk(configSnapshot, generation)).catch(() => {});
    }, 200);
}

function flushConfigImmediately() {
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
    }
    // Invalidate queued/in-flight async writes first: the synchronous flush
    // below is authoritative and must not lose a last-writer race against a
    // slower debounced snapshot.
    writeGeneration++;
    if (cachedConfig) {
        const configSnapshot = { ...loadConfig() };
        let tempPath = null;
        try {
            tempPath = `${configPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify(configSnapshot, null, 2), 'utf8');
            fs.renameSync(tempPath, configPath);
            tempPath = null;
        } catch (e) {
            console.error('Failed to save config synchronously:', e.message || e);
            if (tempPath) { try { fs.unlinkSync(tempPath); } catch (e2) { /* ignore */ } }
        }
    }
}

function loadConfig() {
    if (cachedConfig) return { ...cachedConfig };
    try {
        if (typeof configPath !== 'undefined' && fs.existsSync(configPath)) {
            const cfg = migrateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
            if (!cfg.uiLanguage) cfg.uiLanguage = mapUiLanguage(getSystemLocale());
            if (!WIDGET_STYLES.includes(cfg.widgetStyle)) cfg.widgetStyle = 'crimson';
            cachedConfig = cfg;
            return { ...cachedConfig };
        }
    } catch (e) {
        console.error('Failed to load config:', e.message || e);
        // Preserve the unreadable file once so corruption or a transient
        // read error can't be silently overwritten by a defaults-only save.
        try {
            const backupPath = `${configPath}.corrupt`;
            if (fs.existsSync(configPath) && !fs.existsSync(backupPath)) {
                fs.copyFileSync(configPath, backupPath);
            }
        } catch (backupError) { /* best effort */ }
    }
    const cfg = migrateConfig({});
    if (!cfg.uiLanguage) cfg.uiLanguage = mapUiLanguage(getSystemLocale());
    cachedConfig = cfg;
    return { ...cachedConfig };
}

function saveConfig(data) {
    try {
        const current = loadConfig();
        cachedConfig = migrateConfig({ ...current, ...data });
        scheduleDiskWrite();
        return true;
    } catch (e) {
        console.error('Failed to save config:', e.message || e);
        return false;
    }
}

function getInitialAppearance() {
    const config = loadConfig();
    return {
        widgetStyle: WIDGET_STYLES.includes(config.widgetStyle) ? config.widgetStyle : 'crimson',
        idleFadeEnabled: config.idleFadeEnabled !== false,
        idleOpacity: typeof config.idleOpacity === 'number' ? Math.max(0.1, Math.min(0.9, config.idleOpacity)) : 0.65,
        uiLanguage: typeof config.uiLanguage === 'string' && LOCALES[config.uiLanguage]
            ? config.uiLanguage
            : mapUiLanguage(getSystemLocale())
    };
}

function getUiLanguage() {
    const c = loadConfig();
    if (c && typeof c.uiLanguage === 'string' && LOCALES[c.uiLanguage]) return c.uiLanguage;
    return mapUiLanguage(getSystemLocale());
}

function getApiKeys() {
    const keys = [];
    const envKey = process.env.GEMINI_API_KEY;
    if (envKey && envKey.trim()) keys.push(envKey.trim());
    const config = loadConfig();
    if (typeof config.apiKey === 'string' && config.apiKey.trim()) keys.push(config.apiKey.trim());
    if (Array.isArray(config.apiKeys)) {
        for (const k of config.apiKeys) {
            if (typeof k === 'string' && k.trim()) keys.push(k.trim());
        }
    }
    return [...new Set(keys)];
}

function getApiKey() {
    return getApiKeys()[0] || '';
}

function cooldownKey(rawKey) {
    return crypto.createHash('sha256').update(String(rawKey)).digest('hex').slice(0, 32);
}

async function getSettingsSnapshot(sttService) {
    const config = loadConfig();
    const localModelKey = getModelKey(config.localTier, config.localLanguage);
    const modelStatus = sttService ? await sttService.getStatus(localModelKey) : { installed: false, available: false, reason: null };
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
        outputMode: config.outputMode || 'clipboard',
        autotypeMethod: config.autotypeMethod || 'unicode',
        pressEnter: config.pressEnter === true,
        alwaysCopyToClipboard: config.alwaysCopyToClipboard !== false,
        spacePaste: config.outputMode ? config.outputMode !== 'clipboard' : (config.spacePaste === true),
        pasteStyle: config.outputMode === 'toast' || config.pasteStyle === 'toast' ? 'toast' : 'bubble',
        pasteKey: typeof config.pasteKey === 'string' && config.pasteKey.length <= 12 ? config.pasteKey : ' ',
        silenceThreshold: typeof config.silenceThreshold === 'number' ? Math.max(2, Math.min(100, config.silenceThreshold)) : 12,
        ecoMode: config.ecoMode !== false,
        alwaysOnTop: typeof config.alwaysOnTop === 'boolean' ? config.alwaysOnTop : true,
        idleFadeEnabled: config.idleFadeEnabled !== false,
        idleOpacity: typeof config.idleOpacity === 'number' ? Math.max(0.1, Math.min(0.9, config.idleOpacity)) : 0.65,
        geminiModel: config.geminiModel || 'gemini-2.5-flash',
        uiLanguage: typeof config.uiLanguage === 'string' && LOCALES[config.uiLanguage] ? config.uiLanguage : mapUiLanguage(getSystemLocale()),
        widgetStyle: WIDGET_STYLES.includes(config.widgetStyle) ? config.widgetStyle : 'crimson',
        systemRamGB: systemRamGB(),
        recommendedTier: recommendedTierForRam(systemRamGB()),
        playFinishSound: config.playFinishSound !== false,
        saveRecordings: config.saveRecordings === true,
        recordingsPath: recordingsDir,
        micDeviceId: config.micDeviceId || '',
        micDeviceLabel: config.micDeviceLabel || '',
        historyEnabled: config.historyEnabled === true,
        historyLimit: typeof config.historyLimit === 'number' ? Math.max(10, Math.min(500, Math.round(config.historyLimit))) : 50,
        // First-run flag: config file didn't exist at boot AND the user never
        // dismissed the tour. The renderer calls mark-first-run-done once.
        firstRun: !configFileExistedAtBoot && config.firstRunDone !== true
    };
}

module.exports = {
    canonicalUserDataPath,
    configPath,
    modelsDir,
    recordingsDir,
    historyPath,
    migrateLegacyConfig,
    migrateLegacyUserData,
    loadConfig,
    saveConfig,
    flushConfigImmediately,
    getInitialAppearance,
    getUiLanguage,
    getApiKeys,
    getApiKey,
    cooldownKey,
    getSettingsSnapshot
};
