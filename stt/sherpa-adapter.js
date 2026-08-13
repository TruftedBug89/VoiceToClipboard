const path = require('path');
const sherpa = require('sherpa-onnx-node');
const { getModel } = require('./model-registry');
const { validatePcm } = require('./audio');
const { numThreadsFor } = require('./threading');

function getRequiredPath(root, fileName) {
    return path.join(root, fileName);
}

// sherpa-onnx-node exposes explicit release handles on newer builds, but older
// ones only free the native recognizer when V8 garbage-collects its wrapper.
// We do both: call any explicit releaser that exists, then schedule a forced
// GC (main.js enables --expose-gc) so the ~0.3–1.2 GB of native RAM comes back
// immediately when Power-Saving Mode unloads the model.
function freeNativeMemory(recognizer) {
    if (!recognizer) return;
    for (const method of ['free', 'delete', 'close', 'dispose', 'release']) {
        try {
            const fn = recognizer[method];
            if (typeof fn === 'function') {
                fn.call(recognizer);
                return;
            }
        } catch (e) { /* keep trying other releasers */ }
    }
}

function scheduleGc() {
    setImmediate(() => {
        try { global.gc && global.gc(); } catch (e) { /* --expose-gc not set: lazy GC */ }
    });
}

class SherpaAdapter {
    constructor(cache) {
        this.cache = cache;
        this.loaded = null;
    }

    async load(modelKey) {
        if (this.loaded?.modelKey === modelKey) {
            // If the language hint changed (UI language switched), rebuild the
            // recognizer so SenseVoice picks up the new language.
            if (this.loaded.langHint === this._senseVoiceLanguage) return this.loaded;
            await this.unload();
        } else {
            await this.unload();
        }
        const modelPath = await this.cache.getInstalledPath(modelKey);
        if (!modelPath) throw new Error('Model weights are not downloaded yet.');

        const registryModel = getModel(modelKey);

        let config;
        if (registryModel.backend === 'parakeet') {
            config = {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    transducer: {
                        encoder: getRequiredPath(modelPath, 'encoder.int8.onnx'),
                        decoder: getRequiredPath(modelPath, 'decoder.int8.onnx'),
                        joiner: getRequiredPath(modelPath, 'joiner.int8.onnx')
                    },
                    tokens: getRequiredPath(modelPath, 'tokens.txt'),
                    modelType: 'nemo_transducer'
                },
                numThreads: numThreadsFor(modelKey),
                provider: 'cpu',
                debug: 0
            };
        } else if (registryModel.backend === 'nemo-ctc') {
            config = {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    nemoCtc: {
                        model: getRequiredPath(modelPath, 'model.int8.onnx')
                    },
                    tokens: getRequiredPath(modelPath, 'tokens.txt')
                },
                numThreads: numThreadsFor(modelKey),
                provider: 'cpu',
                debug: 0
            };
        } else if (registryModel.backend === 'nemo-transducer') {
            config = {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    transducer: {
                        encoder: getRequiredPath(modelPath, 'encoder.int8.onnx'),
                        decoder: getRequiredPath(modelPath, 'decoder.int8.onnx'),
                        joiner: getRequiredPath(modelPath, 'joiner.int8.onnx')
                    },
                    tokens: getRequiredPath(modelPath, 'tokens.txt')
                },
                numThreads: numThreadsFor(modelKey),
                provider: 'cpu',
                debug: 0
            };
        } else if (registryModel.backend === 'sense-voice') {
            config = {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    senseVoice: {
                        model: getRequiredPath(modelPath, 'model.int8.onnx'),
                        language: this._senseVoiceLanguage || 'auto',
                        useInverseTextNormalization: 1
                    },
                    tokens: getRequiredPath(modelPath, 'tokens.txt')
                },
                numThreads: numThreadsFor(modelKey),
                provider: 'cpu',
                debug: 0
            };
        } else if (registryModel.backend === 'fire-red-asr-ctc') {
            config = {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    fireRedAsrCtc: {
                        model: getRequiredPath(modelPath, 'model.int8.onnx')
                    },
                    tokens: getRequiredPath(modelPath, 'tokens.txt')
                },
                numThreads: numThreadsFor(modelKey),
                provider: 'cpu',
                debug: 0
            };
        } else if (registryModel.backend === 'omnilingual' || registryModel.modelType === 'omnilingual') {
            config = {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    omnilingual: {
                        model: getRequiredPath(modelPath, 'model.int8.onnx')
                    },
                    tokens: getRequiredPath(modelPath, 'tokens.txt')
                },
                numThreads: numThreadsFor(modelKey),
                provider: 'cpu',
                debug: 0
            };
        } else if (registryModel.backend === 'whisper') {
            // Whisper model files use a model-specific prefix (e.g. small-encoder.int8.onnx,
            // large-v3-turbo-decoder.int8.onnx). Find them from expectedFiles.
            const ef = registryModel.expectedFiles;
            const encFile = ef.find(f => f.includes('encoder')) || 'encoder.int8.onnx';
            const decFile = ef.find(f => f.includes('decoder')) || 'decoder.int8.onnx';
            const tokFile = ef.find(f => f.includes('tokens')) || 'tokens.txt';
            config = {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    whisper: {
                        encoder: getRequiredPath(modelPath, encFile),
                        decoder: getRequiredPath(modelPath, decFile),
                        // sherpa-onnx rejects language 'auto' for Whisper: the C++
                        // decoder aborts the whole process at decode time
                        // ("Invalid language: auto"). A concrete language token must
                        // be chosen; fall back to English like a transparent default.
                        language: this._whisperLanguage || 'en',
                        task: 'transcribe',
                        tailPaddings: 1000
                    },
                    tokens: getRequiredPath(modelPath, tokFile)
                },
                // Whisper/large batch models decode the whole log-mel window at once.
                // Cap the analysis window so a multi-minute clip is chunked to ~30 s
                // segments — far faster wall-clock on CPU with no RAM penalty.
                maxModelSec: 30,
                numThreads: numThreadsFor(modelKey),
                provider: 'cpu',
                debug: 0
            };
        } else if (registryModel.backend === 'moonshine') {
            const fs = require('fs');
            const pre = getRequiredPath(modelPath, 'preprocess.onnx');
            const enc = fs.existsSync(path.join(modelPath, 'encode.int8.onnx')) ? 'encode.int8.onnx' : 'encode.onnx';
            const unc = fs.existsSync(path.join(modelPath, 'uncached_decode.int8.onnx')) ? 'uncached_decode.int8.onnx' : 'uncached_decode.onnx';
            const cas = fs.existsSync(path.join(modelPath, 'cached_decode.int8.onnx')) ? 'cached_decode.int8.onnx' : 'cached_decode.onnx';
            config = {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    moonshine: {
                        preprocessor: pre,
                        encoder: getRequiredPath(modelPath, enc),
                        uncachedDecoder: getRequiredPath(modelPath, unc),
                        cachedDecoder: getRequiredPath(modelPath, cas)
                    },
                    tokens: getRequiredPath(modelPath, 'tokens.txt')
                },
                numThreads: numThreadsFor(modelKey),
                provider: 'cpu',
                debug: 0
            };
        } else {
            throw new Error('Unsupported Sherpa model backend.');
        }

        const recognizer = await sherpa.OfflineRecognizer.createAsync(config);
        this.loaded = { modelKey, recognizer, modelPath, langHint: this._senseVoiceLanguage };
        return this.loaded;
    }

    async unload() {
        if (!this.loaded) return;
        const { recognizer } = this.loaded;
        this.loaded = null;
        freeNativeMemory(recognizer);
        scheduleGc();
    }

    async transcribe(modelKey, pcm, sampleRate = 16000, opts = {}) {
        // Language hint from the UI language (SenseVoice supports zh/en/yue/ja/ko,
        // Whisper needs a concrete language code — never 'auto').
        if (opts && opts.uiLanguage) {
            const langMap = { zh: 'zh', en: 'en', es: 'auto', ja: 'ja', ko: 'ko' };
            this._senseVoiceLanguage = langMap[opts.uiLanguage] || 'auto';
            const whisperLangMap = { zh: 'zh', en: 'en', es: 'es', ja: 'ja', ko: 'ko' };
            this._whisperLanguage = whisperLangMap[opts.uiLanguage] || 'en';
        }
        const samples = validatePcm(pcm, sampleRate);
        const loaded = await this.load(modelKey);
        const stream = loaded.recognizer.createStream();
        try {
            stream.acceptWaveform({ sampleRate, samples });
            const result = await loaded.recognizer.decodeAsync(stream);
            return (result?.text || loaded.recognizer.getResult(stream)?.text || '').trim();
        } finally {
            freeNativeMemory(stream);
        }
    }
}

module.exports = { SherpaAdapter };