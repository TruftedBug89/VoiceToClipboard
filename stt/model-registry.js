// Model registry for the offline (local) STT engines.
//
// Every model is multilingual / bilingual and auto-detects the language, so
// the user never picks a language. Tiers map 1:1 to models; the Settings UI
// lists them all so the user can pick the trade-off they want
// (download size / RAM / precision / language coverage).
//
// Integrity pins (verified 2026-08-13 against the live release assets):
//   sha256      — hex sha256 of the downloaded archive (downloadUrl).
//   fileHashes  — { filename: hex sha256 } for per-file mirror downloads.
// model-cache.js verifies these in install() (see verifyArchiveIntegrity /
// verifyMirrorFile). A model without a pin skips the check; a model WITH a
// pin is rejected on mismatch before its files are ever loaded by native code.
const MODEL_REGISTRY = Object.freeze({
    'tiny-multilingual': {
        key: 'tiny-multilingual',
        tier: 'tiny',
        backend: 'zipformer',
        modelType: 'zipformer_transducer',
        language: 'auto',
        languages: ['en', 'es'],
        name: 'Zipformer Transducer · Lightning Fast (INT8)',
        description: 'k2-fsa Zipformer Transducer INT8 (LibriSpeech). Lightning-fast offline English dictation with the smallest download and lowest RAM usage.',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-en-2023-06-26.tar.bz2',
        mirrorBase: 'https://huggingface.co/csukuangfj/sherpa-onnx-zipformer-en-2023-06-26/resolve/main',
        archiveName: 'sherpa-onnx-zipformer-en-2023-06-26.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['encoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.int8.onnx', 'joiner-epoch-99-avg-1.int8.onnx', 'tokens.txt'],
        downloadBytes: 307666046,
        sha256: '652181d80dfe0e8e0659cf32036d1d6ef56fa2f1ab5b35c54d0cee8a663e8954',
        fileHashes: {
            'encoder-epoch-99-avg-1.int8.onnx': '52a48f46c17b19a36fe3927c4d59479bb16eeb2493313ed82c4bf775c2cb8bc8',
            'decoder-epoch-99-avg-1.int8.onnx': '783cd6b23b8db8e14a43804ecf972ae96e71499cce799e334ab95c961800d797',
            'joiner-epoch-99-avg-1.int8.onnx': '48de5d6467a2ab1e72cb5c4d828330be06524d877bc458118b6a4198ca031357',
            'tokens.txt': '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb'
        },
        ramEstimate: 'about 180 MB RAM',
        sourceUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-zipformer-en-2023-06-26',
        license: 'Apache-2.0',
        verified: true,
        notes: 'Zipformer Transducer INT8 (LibriSpeech). 3× faster than Moonshine, smallest footprint.'
    },
    'mini-multilingual': {
        key: 'mini-multilingual',
        tier: 'mini',
        backend: 'nemo-transducer',
        modelType: 'nemo_transducer',
        language: 'auto',
        name: 'FastConformer Transducer · Ultra-Fast (Recommended)',
        description: 'NVIDIA NeMo FastConformer Transducer INT8 (~102 MB). Ultra-fast, highly accurate for English, Spanish, German, French, Italian, and 10 languages. Recommended default.',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-fast-conformer-transducer-be-de-en-es-fr-hr-it-pl-ru-uk-20k-int8.tar.bz2',
        archiveName: 'sherpa-onnx-nemo-fast-conformer-transducer-be-de-en-es-fr-hr-it-pl-ru-uk-20k-int8.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
        downloadBytes: 102 * 1024 * 1024,
        sha256: '06072bad277f0f4c29cc866d7c62b0e47936da39afafeae453faa925025ccad6',
        ramEstimate: 'about 270 MB RAM',
        sourceUrl: 'https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer.html',
        license: 'NVIDIA model release (CC-BY-4.0)',
        verified: true,
        recommended: true,
        fast: true,
        notes: 'NeMo FastConformer Transducer int8 (20k vocab, 10 languages). Verified live on EN/ES/DE/FR/IT/PL samples.'
    },
    'zh-en-light': {
        key: 'zh-en-light',
        tier: 'zh-light',
        backend: 'sense-voice',
        modelType: 'sense_voice',
        language: 'auto',
        name: 'SenseVoice · Chinese + English (Light)',
        description: 'Alibaba SenseVoice int8 — mainly Chinese, plus English, Cantonese, Japanese, Korean. Automatic language detection, ~400 MB RAM.',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2',
        mirrorBase: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main',
        archiveName: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['model.int8.onnx', 'tokens.txt'],
        downloadBytes: 158 * 1024 * 1024,
        sha256: '7305f7905bfcf77fa0b39388a313f3da35c68d971661a65475b56fb2162c8e63',
        fileHashes: {
            'model.int8.onnx': '12ca1a2ae7ecf3e0019ef2822307ee0b5cadc9196569e379b4c4026f8205276d',
            'tokens.txt': 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'
        },
        ramEstimate: 'about 400 MB RAM',
        sourceUrl: 'https://github.com/FunAudioLLM/SenseVoice',
        license: 'SenseVoice model license (Apache-2.0 compatible)',
        verified: true,
        fast: true,
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
        mirrorBase: 'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/main',
        archiveName: 'sherpa-onnx-whisper-small.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['small-encoder.int8.onnx', 'small-decoder.int8.onnx', 'small-tokens.txt'],
        downloadBytes: 639387718,
        sha256: '486a46afbb7ba798507190ffe02fea2dd726049af212e774537efac6afb210a6',
        fileHashes: {
            'small-encoder.int8.onnx': '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9',
            'small-decoder.int8.onnx': 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee',
            'small-tokens.txt': 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'
        },
        ramEstimate: 'about 550 MB RAM',
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
        name: 'Whisper Turbo INT8 · Max Precision',
        description: 'Maximum-precision OpenAI Whisper Turbo INT8. SOTA accuracy for English, Spanish, Chinese, and 99+ languages with distilled 4-layer decoder.',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2',
        mirrorBase: 'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/main',
        archiveName: 'sherpa-onnx-whisper-turbo.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['turbo-encoder.int8.onnx', 'turbo-decoder.int8.onnx', 'turbo-tokens.txt'],
        downloadBytes: 563790207,
        sha256: 'b11acbbcd660b44a8e0df33724feb5aaa709cf65668f2823d59f656312544f22',
        fileHashes: {
            'turbo-encoder.int8.onnx': 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b',
            'turbo-decoder.int8.onnx': '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547',
            'turbo-tokens.txt': 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'
        },
        ramEstimate: 'about 950 MB RAM',
        sourceUrl: 'https://github.com/openai/whisper',
        license: 'MIT License (OpenAI)',
        verified: true,
        notes: 'Whisper Turbo INT8 (distilled large-v3). Top-tier precision for EN/ES/ZH and global languages.'
    },
    'zh-en-big': {
        key: 'zh-en-big',
        tier: 'zh-big',
        backend: 'fire-red-asr-ctc',
        modelType: 'fire_red_asr_ctc',
        language: 'auto',
        name: 'FireRedASR2 CTC · Chinese + English (Big)',
        description: 'ByteDance FireRedASR2 int8 — mainly Chinese, plus English. The highest-precision Chinese model here (~1.1 GB RAM).',
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25.tar.bz2',
        mirrorBase: 'https://huggingface.co/csukuangfj2/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25/resolve/main',
        archiveName: 'sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25.tar.bz2',
        archiveType: 'tar.bz2',
        expectedFiles: ['model.int8.onnx', 'tokens.txt'],
        downloadBytes: 496 * 1024 * 1024,
        sha256: '1da8b737ecc5e29f36759a4460c754863e7c919a4ba325aea187331fbfc83274',
        fileHashes: {
            'model.int8.onnx': 'ca3dbabd82170110cc0b343c2890866d449984bc9cd92b9a18371ff80a81bb99',
            'tokens.txt': '1bc613de2112d257e61a349c3e72d1b1a9cf19c33d3ca954197ad2171e5ea07b'
        },
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
