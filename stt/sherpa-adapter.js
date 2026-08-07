const os = require('os');
const path = require('path');
const sherpa = require('sherpa-onnx-node');
const { getModel } = require('./model-registry');
const { validatePcm } = require('./audio');

function getRequiredPath(root, fileName) {
    return path.join(root, fileName);
}

class SherpaAdapter {
    constructor(cache) {
        this.cache = cache;
        this.loaded = null;
    }

    async load(modelKey) {
        if (this.loaded?.modelKey === modelKey) return this.loaded;
        await this.unload();
        const modelPath = await this.cache.getInstalledPath(modelKey);
        if (!modelPath) throw new Error('Model weights are not downloaded yet.');

        const registryModel = getModel(modelKey);

        let config;
        if (registryModel.backend === 'moonshine') {
            config = {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    moonshine: {
                        encoder: getRequiredPath(modelPath, 'encoder_model.ort'),
                        mergedDecoder: getRequiredPath(modelPath, 'decoder_model_merged.ort')
                    },
                    tokens: getRequiredPath(modelPath, 'tokens.txt')
                },
                numThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
                provider: 'cpu',
                debug: 0
            };
        } else if (registryModel.backend === 'parakeet') {
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
                numThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
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
                numThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
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
                numThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
                provider: 'cpu',
                debug: 0
            };
        } else if (registryModel.backend === 'sense-voice') {
            config = {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    senseVoice: {
                        model: getRequiredPath(modelPath, 'model.int8.onnx'),
                        language: 'auto',
                        useInverseTextNormalization: 1
                    },
                    tokens: getRequiredPath(modelPath, 'tokens.txt')
                },
                numThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
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
                numThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
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
                numThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
                provider: 'cpu',
                debug: 0
            };
        } else {
            throw new Error('Unsupported Sherpa model backend.');
        }

        const recognizer = await sherpa.OfflineRecognizer.createAsync(config);
        this.loaded = { modelKey, recognizer, modelPath };
        return this.loaded;
    }

    async unload() {
        if (!this.loaded) return;
        this.loaded = null;
    }

    async transcribe(modelKey, pcm, sampleRate = 16000) {
        const samples = validatePcm(pcm, sampleRate);
        const loaded = await this.load(modelKey);
        const stream = loaded.recognizer.createStream();
        stream.acceptWaveform({ sampleRate, samples });
        const result = await loaded.recognizer.decodeAsync(stream);
        return (result?.text || loaded.recognizer.getResult(stream)?.text || '').trim();
    }
}

module.exports = { SherpaAdapter };
