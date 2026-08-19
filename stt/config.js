const CONFIG_VERSION = 6;
const VALID_TIERS = new Set(['tiny', 'mini', 'zh-light', 'light', 'big', 'zh-big']);
const WIDGET_STYLES = ['crimson', 'ocean', 'aurora', 'terminal'];
const VALID_OUTPUT_MODES = new Set(['clipboard', 'bubble', 'toast', 'autotype']);
const VALID_AUTOTYPE_METHODS = new Set(['unicode', 'paste']);

function resolveOutputMode(input = {}) {
    if (VALID_OUTPUT_MODES.has(input.outputMode)) {
        return input.outputMode;
    }
    if (input.spacePaste === false) {
        return 'clipboard';
    }
    if (input.pasteStyle === 'toast') {
        return 'toast';
    }
    if (input.spacePaste === true || input.pasteStyle === 'bubble') {
        return 'bubble';
    }
    return 'clipboard';
}

function resolveAutotypeMethod(input = {}) {
    if (VALID_AUTOTYPE_METHODS.has(input.autotypeMethod)) {
        return input.autotypeMethod;
    }
    return 'unicode';
}

function clampHistoryLimit(val) {
    if (typeof val === 'number' && !isNaN(val)) {
        return Math.max(10, Math.min(500, Math.round(val)));
    }
    return 50;
}

// System RAM (GB) — used to recommend the best model for the user's PC.
// os.totalmem() is the reliable cross-process source (Electron's
// process.getSystemMemoryInfo() can report 0 on some Windows setups).
function systemRamGB() {
    try {
        const os = require('os');
        const bytes = os.totalmem();
        if (typeof bytes === 'number' && bytes > 0) return Math.round(bytes / 1073741824);
    } catch (e) { /* ignore */ }
    return 8;
}

// RAM-based recommendation ladder (multilingual registry backends):
//   ≤ 4 GB -> Tiny (moonshine, ~290 MB RAM)
//   > 4 GB -> Mini (FastConformer Transducer, ~270 MB RAM) — ultra-fast recommended default
function recommendedTierForRam(ramGB) {
    if (ramGB <= 4) return 'tiny';
    return 'mini';
}

// Multilingual-only registry: tiers map 1:1 to models, no language selection.
function deriveLocalModelKey(localTier) {
    if (localTier === 'tiny') return 'tiny-multilingual';
    if (localTier === 'mini') return 'mini-multilingual';
    if (localTier === 'zh-light') return 'zh-en-light';
    if (localTier === 'big') return 'big-multilingual';
    if (localTier === 'zh-big') return 'zh-en-big';
    return 'omni-multilingual';
}

function migrateConfig(input = {}) {
    const config = { ...input };
    const version = config.configVersion || 1;

    if (version < 4) {
        // v1 -> v4: legacy Whisper-era config (localModel string).
        // v2 -> v4: per-language model keys (tiny-en/tiny-es/base-en/base-es)
        //           are replaced by the multilingual registry (light/big).
        let localTier = 'mini';
        if (config.localModelKey === 'big-multilingual') {
            localTier = 'big';
        } else if (typeof config.localModel === 'string' && config.localModel.includes('large')) {
            localTier = 'big';
        }
        config.localTier = localTier;
        config.localLanguage = 'auto';
        config.localModelKey = deriveLocalModelKey(localTier);
        delete config.localModel;

        // v2.1.0: idle transparency is ON by default at 65% for everyone
        // (old configs predate this feature, so apply the new defaults).
        if (version < 2) {
            config.idleFadeEnabled = true;
            config.idleOpacity = 0.65;
        }

        // v2.2+: eco (power-saving) mode ON by default — the model is loaded
        // into RAM only while transcribing. "Keep loaded" stays available as an
        // opt-in via the Power-Saving toggle in Settings.
        config.ecoMode = true;

        // v2.3+: the tier list grew (tiny/mini/zh-light/zh-big added). Re-derive
        // the model key from the tier so any valid tier maps to its model.
        if (VALID_TIERS.has(config.localTier)) {
            config.localModelKey = deriveLocalModelKey(config.localTier);
        }
        config.configVersion = CONFIG_VERSION;
    }

    // Local offline models are the DEFAULT engine; Gemini API is opt-in.
    const sttEngine = config.sttEngine === 'gemini' ? 'gemini' : 'local';
    // Unknown/legacy tiers fall back to the model recommended for this PC's RAM.
    const localTier = VALID_TIERS.has(config.localTier)
        ? config.localTier
        : recommendedTierForRam(systemRamGB());
    const localLanguage = 'auto';

    return {
        ...config,
        configVersion: CONFIG_VERSION,
        sttEngine,
        localTier,
        localLanguage,
        localModelKey: deriveLocalModelKey(localTier),
        playFinishSound: config.playFinishSound !== false,
        saveRecordings: typeof config.saveRecordings === 'boolean' ? config.saveRecordings : false,
        outputMode: resolveOutputMode(config),
        autotypeMethod: resolveAutotypeMethod(config),
        micDeviceId: typeof config.micDeviceId === 'string' ? config.micDeviceId : '',
        micDeviceLabel: typeof config.micDeviceLabel === 'string' ? config.micDeviceLabel : '',
        historyEnabled: typeof config.historyEnabled === 'boolean' ? config.historyEnabled : false,
        historyLimit: clampHistoryLimit(config.historyLimit)
    };
}

function validateSttConfig(input = {}) {
    const settings = input && typeof input === 'object' ? input : {};
    const localTier = VALID_TIERS.has(settings.localTier)
        ? settings.localTier
        : recommendedTierForRam(systemRamGB());
    const validGeminiModels = new Set(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite']);
    const widgetStyle = WIDGET_STYLES.includes(settings.widgetStyle) ? settings.widgetStyle : 'crimson';
    return {
        sttEngine: settings.sttEngine === 'gemini' ? 'gemini' : 'local',
        localTier,
        localLanguage: 'auto',
        localModelKey: deriveLocalModelKey(localTier),
        geminiModel: validGeminiModels.has(settings.geminiModel) ? settings.geminiModel : 'gemini-2.5-flash',
        ecoMode: settings.ecoMode !== false,
        playFinishSound: settings.playFinishSound !== false,
        saveRecordings: typeof settings.saveRecordings === 'boolean' ? settings.saveRecordings : false,
        outputMode: resolveOutputMode(settings),
        autotypeMethod: resolveAutotypeMethod(settings),
        micDeviceId: typeof settings.micDeviceId === 'string' ? settings.micDeviceId : '',
        micDeviceLabel: typeof settings.micDeviceLabel === 'string' ? settings.micDeviceLabel : '',
        historyEnabled: typeof settings.historyEnabled === 'boolean' ? settings.historyEnabled : false,
        historyLimit: clampHistoryLimit(settings.historyLimit),
        widgetStyle
    };
}

module.exports = {
    CONFIG_VERSION,
    WIDGET_STYLES,
    deriveLocalModelKey,
    migrateConfig,
    validateSttConfig,
    systemRamGB,
    recommendedTierForRam
};
