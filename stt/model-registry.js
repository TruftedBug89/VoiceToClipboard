// Model registry for the offline (local) STT engines.
//
// Every model is multilingual / bilingual and auto-detects the language, so
// the user never picks a language. Tiers map 1:1 to models; the Settings UI
// lists them all so the user can pick the trade-off they want
// (download size / RAM / precision / language coverage).
const MODEL_REGISTRY = Object.freeze({
    'tiny-multilingual': {
        key: 'tiny-multilingual',
        tier: 'tiny',
        backend: 'nemo-ctc',
        modelType: 'nemo_ctc',
        language: 'auto',
        name: 'FastConformer CTC · EN/DE/ES/FR',
        description: 'Tiny NVIDIA NeMo FastConformer CTC. Automatic English, German, Spanish, French — one model, ~4× lighter than the universal model.',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-fast-conformer-ctc-en-de-es-fr-14288-int8.tar.bz2',
        archiveName: 'sherpa-onnx-nemo-fast-conformer-ctc-en-de-es-fr-14288-int8.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['model.int8.onnx', 'tokens.txt'],
        downloadBytes: 98 * 1024 * 1024,
        ramEstimate: 'about 250 MB RAM',
        sourceUrl: 'https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/nemo-ctc.html',
        license: 'NVIDIA model release (CC-BY-4.0)',
        verified: true,
        notes: 'NeMo FastConformer CTC int8 (14288 vocab). Auto-detects en/de/es/fr; verified live on EN/ES/DE/FR samples.'
    },
    'mini-multilingual': {
        key: 'mini-multilingual',
        tier: 'mini',
        backend: 'nemo-transducer',
        modelType: 'nemo_transducer',
        language: 'auto',
        name: 'FastConformer Transducer · 10 languages',
        description: 'Mini NVIDIA NeMo FastConformer Transducer. Auto English, German, Spanish, French, Italian, Polish, Russian, Ukrainian, Croatian, Belgian — the best light multilingual pick.',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-fast-conformer-transducer-be-de-en-es-fr-hr-it-pl-ru-uk-20k-int8.tar.bz2',
        archiveName: 'sherpa-onnx-nemo-fast-conformer-transducer-be-de-en-es-fr-hr-it-pl-ru-uk-20k-int8.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
        downloadBytes: 102 * 1024 * 1024,
        ramEstimate: 'about 270 MB RAM',
        sourceUrl: 'https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer.html',
        license: 'NVIDIA model release (CC-BY-4.0)',
        verified: true,
        notes: 'NeMo FastConformer Transducer int8 (20k vocab, 10 languages). Verified live on EN/ES/DE/FR/IT/PL samples.'
    },
    'zh-en-light': {
        key: 'zh-en-light',
        tier: 'zh-light',
        backend: 'sense-voice',
        modelType: 'sense_voice',
        language: 'auto',
        name: 'SenseVoice · Chinese + English (Light)',
        description: 'Alibaba SenseVoice int8 — mainly Chinese, plus English, Cantonese, Japanese, Korean. Automatic language detection, ~300 MB RAM.',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2',
        archiveName: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['model.int8.onnx', 'tokens.txt'],
        downloadBytes: 158 * 1024 * 1024,
        ramEstimate: 'about 400 MB RAM',
        sourceUrl: 'https://github.com/FunAudioLLM/SenseVoice',
        license: 'SenseVoice model license (Apache-2.0 compatible)',
        verified: true,
        notes: 'Alibaba SenseVoice small int8. Strong on Mandarin; also covers en/yue/ja/ko with language=auto + ITN. Verified live on zh/en samples.'
    },
    'omni-multilingual': {
        key: 'omni-multilingual',
        tier: 'light',
        backend: 'omnilingual',
        modelType: 'omnilingual',
        language: 'auto',
        name: 'Omnilingual ASR 300M v2 (INT8)',
        description: 'One model, 1600+ languages, automatic language detection. Talk in any language — no settings, no thinking. The universal middle-ground pick.',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05.tar.bz2',
        archiveName: 'sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['model.int8.onnx', 'tokens.txt'],
        downloadBytes: 279 * 1024 * 1024,
        ramEstimate: 'about 550 MB RAM',
        sourceUrl: 'https://k2-fsa.github.io/sherpa/onnx/omnilingual-asr/index.html',
        license: 'Apache-2.0 (Facebook Research omnilingual)',
        verified: true,
        notes: 'Omnilingual 300M CTC int8 v2 (2026-02-05). Covers 1600+ languages in one model; no language selection required.'
    },
    'big-multilingual': {
        key: 'big-multilingual',
        tier: 'big',
        backend: 'parakeet',
        modelType: 'nemo_transducer',
        language: 'auto',
        name: 'Parakeet-TDT 0.6B v3 INT8',
        description: 'Maximum-precision multilingual model. Automatic language detection for ~25 European languages including English and Spanish.',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
        archiveName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
        downloadBytes: 465 * 1024 * 1024,
        ramEstimate: 'about 950 MB RAM',
        sourceUrl: 'https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html',
        license: 'Model license follows NVIDIA model release',
        verified: true,
        notes: 'Parakeet-TDT 0.6B v3 INT8 covers ~25 European languages with automatic language handling. Best precision for EN/ES/DE/FR etc.'
    },
    'zh-en-big': {
        key: 'zh-en-big',
        tier: 'zh-big',
        backend: 'fire-red-asr-ctc',
        modelType: 'fire_red_asr_ctc',
        language: 'auto',
        name: 'FireRedASR2 CTC · Chinese + English (Big)',
        description: 'ByteDance FireRedASR2 int8 — mainly Chinese, plus English. The highest-precision Chinese model here (~800 MB RAM).',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25.tar.bz2',
        archiveName: 'sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['model.int8.onnx', 'tokens.txt'],
        downloadBytes: 496 * 1024 * 1024,
        ramEstimate: 'about 1.1 GB RAM',
        sourceUrl: 'https://github.com/FireRedTeam/FireRedASR',
        license: 'FireRedASR model license',
        verified: true,
        notes: 'ByteDance FireRedASR2 CTC int8 (2026-02-25). Strong Mandarin; handles zh/en code-switching. Verified live on zh/en samples.'
    }
});

function getModel(modelKey) {
    const model = MODEL_REGISTRY[modelKey];
    if (!model) throw new Error(`Unknown local model: ${modelKey}`);
    return model;
}

// Multilingual-only registry: every tier maps to exactly one model, so the
// user never picks a language. Unknown/legacy tiers fall back to the
// universal light model.
function getModelKey(tier, language) {
    if (tier === 'tiny') return 'tiny-multilingual';
    if (tier === 'mini') return 'mini-multilingual';
    if (tier === 'zh-light') return 'zh-en-light';
    if (tier === 'big') return 'big-multilingual';
    if (tier === 'zh-big') return 'zh-en-big';
    return 'omni-multilingual';
}

function getModelsForTier(tier) {
    return Object.values(MODEL_REGISTRY).filter(model => model.tier === tier);
}

module.exports = {
    MODEL_REGISTRY,
    getModel,
    getModelKey,
    getModelsForTier
};
