const CONFIG_VERSION = 5;
const VALID_TIERS = new Set(['tiny', 'mini', 'zh-light', 'light', 'big', 'zh-big']);

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

    const sttEngine = config.sttEngine === 'local' ? 'local' : 'gemini';
    const localTier = VALID_TIERS.has(config.localTier) ? config.localTier : 'light';
    const localLanguage = 'auto';

    return {
        ...config,
        configVersion: CONFIG_VERSION,
        sttEngine,
        localTier,
        localLanguage,
        localModelKey: deriveLocalModelKey(localTier)
    };
}

function validateSttConfig(input = {}) {
    const localTier = VALID_TIERS.has(input.localTier) ? input.localTier : 'light';
    const validGeminiModels = new Set(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash']);
    return {
        sttEngine: input.sttEngine === 'local' ? 'local' : 'gemini',
        localTier,
        localLanguage: 'auto',
        localModelKey: deriveLocalModelKey(localTier),
        geminiModel: validGeminiModels.has(input.geminiModel) ? input.geminiModel : 'gemini-2.5-flash',
        ecoMode: input.ecoMode !== false
    };
}

module.exports = {
    CONFIG_VERSION,
    deriveLocalModelKey,
    migrateConfig,
    validateSttConfig
};
