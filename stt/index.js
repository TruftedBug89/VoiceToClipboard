// Patch koffi.load() for packaged (asar) builds BEFORE vosk-koffi loads its DLLs.
require('./koffi-asar-fix').applyKoffiAsarFix();
// MUST run before sherpa-adapter loads sherpa-onnx-node's native addon.
require('./ort-preload').preloadOrt();

const { MODEL_REGISTRY, getModel } = require('./model-registry');
const { ModelCache } = require('./model-cache');
const { validatePcm } = require('./audio');
const { VoskAdapter } = require('./vosk-adapter');
const { SherpaAdapter } = require('./sherpa-adapter');
const { sanitizeErrorMessage } = require('./error-sanitizer');

function normalizeError(error) {
    const message = sanitizeErrorMessage(error || 'Unknown transcription error.');
    if (/weights|download|model/i.test(message)) return { code: 'MODEL_UNAVAILABLE', message };
    if (/api key|configured/i.test(message)) return { code: 'NO_API_KEY', message };
    if (/network|http|timeout|fetch/i.test(message)) return { code: 'NETWORK_ERROR', message };
    if (/audio|pcm|sample rate|recording/i.test(message)) return { code: 'AUDIO_ERROR', message };
    return { code: 'TRANSCRIPTION_ERROR', message };
}

class SttService {
    constructor({ modelsDir, geminiTranscriber, copyText = () => {} }) {
        this.registry = MODEL_REGISTRY;
        this.copyText = copyText;
        this.cache = new ModelCache(modelsDir);
        this.geminiTranscriber = geminiTranscriber;
        this.vosk = new VoskAdapter(this.cache);
        this.sherpa = new SherpaAdapter(this.cache);
        this.queue = Promise.resolve();
    }

    getModel(modelKey) {
        return getModel(modelKey);
    }

    async prepare() {
        await this.cache.prepare();
    }

    async getStatus(modelKey) {
        const model = getModel(modelKey);
        return {
            modelKey,
            available: model.verified,
            installed: model.verified ? await this.cache.isInstalled(modelKey) : false,
            reason: model.unavailableReason || null,
            cachePath: this.cache.getPath(modelKey)
        };
    }

    async getCatalog() {
        return Promise.all(Object.values(this.registry).map(async model => ({
            key: model.key,
            tier: model.tier,
            backend: model.backend,
            language: model.language,
            name: model.name,
            description: model.description,
            downloadBytes: model.downloadBytes,
            ramEstimate: model.ramEstimate,
            sourceUrl: model.sourceUrl,
            license: model.license,
            verified: model.verified,
            unavailableReason: model.unavailableReason || null,
            installed: model.verified ? await this.cache.isInstalled(model.key) : false
        })));
    }

    async download(modelKey, onProgress) {
        try {
            return { success: true, path: await this.cache.install(modelKey, onProgress) };
        } catch (error) {
            const normalized = normalizeError(error);
            return { success: false, code: normalized.code, error: normalized.message };
        }
    }

    async remove(modelKey) {
        if (this.vosk.loaded?.modelKey === modelKey) await this.vosk.unload();
        if (this.sherpa.loaded?.modelKey === modelKey) await this.sherpa.unload();
        await this.cache.remove(modelKey);
        return { success: true };
    }

    async unloadAll() {
        await this.vosk.unload();
        await this.sherpa.unload();
    }

    // Hygiene: delete model cache entries that are no longer in the registry
    // (e.g. per-language Vosk/Moonshine models replaced by the multilingual set).
    async cleanupStale() {
        await this.cache.removeStaleModels(Object.keys(this.registry));
    }

    async transcribeLocal({ modelKey, pcm, sampleRate, ecoMode, uiLanguage }) {
        const model = getModel(modelKey);
        if (!model.verified) throw new Error(model.unavailableReason || 'This model is not available.');
        if (!(await this.cache.isInstalled(modelKey))) throw new Error('Model weights are not downloaded yet.');
        const adapter = model.backend === 'vosk' ? this.vosk : this.sherpa;
        const text = await adapter.transcribe(modelKey, pcm, sampleRate, { uiLanguage });
        if (ecoMode !== false) await adapter.unload();
        return text;
    }

    async transcribe(request) {
        const operation = this.queue.then(async () => {
            try {
                if (request.engine === 'gemini') {
                    const result = await this.geminiTranscriber(request);
                    if (!result?.success) return result;
                    return result;
                }

                const pcm = validatePcm(request.pcm, request.sampleRate || 16000);
                const text = await this.transcribeLocal({
                    modelKey: request.modelKey,
                    pcm,
                    sampleRate: request.sampleRate || 16000,
                    ecoMode: request.ecoMode,
                    uiLanguage: request.uiLanguage
                });
                if (!text) return { success: false, code: 'NO_SPEECH', error: 'No speech detected.' };
                this.copyText(text);
                return { success: true, text };
            } catch (error) {
                const normalized = normalizeError(error);
                return { success: false, code: normalized.code, error: normalized.message };
            }
        });
        this.queue = operation.catch(() => undefined);
        return operation;
    }
}

module.exports = {
    SttService,
    normalizeError
};
