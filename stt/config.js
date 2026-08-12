const CONFIG_VERSION = 5;
const VALID_TIERS = new Set(['tiny', 'mini', 'zh-light', 'light', 'big', 'zh-big']);
const WIDGET_STYLES = ['crimson', 'ocean', 'aurora', 'terminal'];

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

// RAM-based recommendation ladder:
//   ≤ 4 GB  -> Tiny        (nemo-ctc, ~250 MB RAM)
//   ≤ 8 GB  -> Mini        (nemo-transducer, ~270 MB RAM)
//   ≤ 16 GB -> Light       (Omnilingual 1600+ langs, ~550 MB RAM) — current default pick
//   > 16 GB -> Big         (Parakeet 0.6B, ~950 MB RAM) — one tier above the default
function recommendedTierForRam(ramGB) {
    if (ramGB <= 4) return 'tiny';
    if (ramGB <= 8) return 'mini';
    if (ramGB <= 16) return 'light';
    return 'big';
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
        let localTier = 'light';
        if (config.localModelKey === 'big-multilingual') {
            localTier = 'big';
        } else if ((config.localModel || '').includes('large')) {
            localTier = 'big';
        }
        config.localTier = localTier;
        config.localLanguage = 'auto';
        config.localModelKey = deriveLocalModelKey(localTier);
        delete config.localModel;

        // v2.1.0: idle transparency is ON by default at 60% for everyone
        // (old configs predate this feature, so apply the new defaults).
        if (version < 2) {
            config.idleFadeEnabled = true;
            config.idleOpacity = 0.6;
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
        saveRecordings: typeof config.saveRecordings === 'boolean' ? config.saveRecordings : false
    };
}

function validateSttConfig(input = {}) {
    const localTier = VALID_TIERS.has(input.localTier)
        ? input.localTier
        : recommendedTierForRam(systemRamGB());
    const validGeminiModels = new Set(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite']);
    const widgetStyle = WIDGET_STYLES.includes(input.widgetStyle) ? input.widgetStyle : 'crimson';
    return {
        sttEngine: input.sttEngine === 'gemini' ? 'gemini' : 'local',
        localTier,
        localLanguage: 'auto',
        localModelKey: deriveLocalModelKey(localTier),
        geminiModel: validGeminiModels.has(input.geminiModel) ? input.geminiModel : 'gemini-2.5-flash',
        ecoMode: input.ecoMode !== false,
        playFinishSound: input.playFinishSound !== false,
        saveRecordings: typeof input.saveRecordings === 'boolean' ? input.saveRecordings : false,
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
