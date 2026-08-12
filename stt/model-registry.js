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
        backend: 'moonshine',
        modelType: 'moonshine',
        language: 'auto',
        name: 'Moonshine v2 Base · Ultra-Fast (INT8)',
        description: 'Useful Sensors Moonshine v2 Base INT8. Lightweight, 5× faster time-to-first-token, auto English, Spanish, Chinese dictation with instant low-RAM wake.',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2',
        archiveName: 'sherpa-onnx-moonshine-base-en-int8.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx', 'tokens.txt'],
        downloadBytes: 65 * 1024 * 1024,
        ramEstimate: 'about 200 MB RAM',
        sourceUrl: 'https://github.com/usefulsensors/moonshine',
        license: 'MIT License (Useful Sensors)',
        verified: true,
        notes: 'Moonshine v2 Base INT8. Optimized for edge dictation; instant low-RAM execution.'
    },
    'mini-multilingual': {
        key: 'mini-multilingual',
        tier: 'mini',
        backend: 'nemo-transducer',
        modelType: 'nemo_transducer',
        language: 'auto',
        name: 'FastConformer Transducer · 10 languages',
        description: 'Mini NVIDIA NeMo FastConformer Transducer. Auto English, German, Spanish, French, Italian, Polish, Russian, Ukrainian, Croatian, Belgian — light multilingual pick.',
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
        backend: 'whisper',
        modelType: 'whisper',
        language: 'auto',
        name: 'Whisper Small INT8 · Global Multilingual',
        description: 'OpenAI Whisper Small INT8. High accuracy across 99+ languages including English, Spanish, Chinese. The universal default pick.',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.tar.bz2',
        archiveName: 'sherpa-onnx-whisper-small.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['small-encoder.int8.onnx', 'small-decoder.int8.onnx', 'small-tokens.txt'],
        downloadBytes: 240 * 1024 * 1024,
        ramEstimate: 'about 500 MB RAM',
        sourceUrl: 'https://github.com/openai/whisper',
        license: 'MIT License (OpenAI)',
        verified: true,
        notes: 'Whisper Small INT8. High-precision universal multilingual transcription with clean capitalization and punctuation.'
    },
    'big-multilingual': {
        key: 'big-multilingual',
        tier: 'big',
        backend: 'whisper',
        modelType: 'whisper',
        language: 'auto',
        name: 'Whisper Large-v3-Turbo INT8',
        description: 'Maximum-precision OpenAI Whisper Large-v3-Turbo INT8. SOTA accuracy for English, Spanish, Chinese, and 99+ languages with distilled 4-layer decoder.',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-large-v3-turbo.tar.bz2',
        archiveName: 'sherpa-onnx-whisper-large-v3-turbo.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['large-v3-turbo-encoder.int8.onnx', 'large-v3-turbo-decoder.int8.onnx', 'large-v3-turbo-tokens.txt'],
        downloadBytes: 440 * 1024 * 1024,
        ramEstimate: 'about 880 MB RAM',
        sourceUrl: 'https://github.com/openai/whisper',
        license: 'MIT License (OpenAI)',
        verified: true,
        notes: 'Whisper Large-v3-Turbo INT8. Top-tier precision for EN/ES/ZH and global languages.'
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
