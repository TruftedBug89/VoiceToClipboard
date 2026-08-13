const { MODEL_REGISTRY, getModel } = require('./model-registry');
const { ModelCache } = require('./model-cache');
const { validatePcm } = require('./audio');
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
        this._sherpa = null;
        this.queue = Promise.resolve();
        this.activeDownloads = new Map();
        this.idleTimer = null;
        this.idleUnloadSeconds = 20;
        this._pendingUnload = null;
    }

    get sherpa() {
        if (!this._sherpa) {
            // The koffi asar fix must be active BEFORE preloadOrt: preloadOrt
            // uses koffi.load() on the sherpa win-x64 DLLs, and in packaged
            // builds those paths point inside app.asar unless rewritten to
            // app.asar.unpacked. Without the rewrite the DLL fails to load,
            // sherpa-onnx createAsync() never resolves and local transcription
            // hangs (packaged builds only — dev paths are real directories).
            require('./koffi-asar-fix').applyKoffiAsarFix();
            require('./ort-preload').preloadOrt();
            const { SherpaAdapter } = require('./sherpa-adapter');
            this._sherpa = new SherpaAdapter(this.cache);
        }
        return this._sherpa;
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
            fast: !!model.fast,
            unavailableReason: model.unavailableReason || null,
            installed: model.verified ? await this.cache.isInstalled(model.key) : false
        })));
    }

    async download(modelKey, onProgress) {
        if (this.activeDownloads.has(modelKey)) {
            this.cancelDownload(modelKey);
        }
        const controller = new AbortController();
        this.activeDownloads.set(modelKey, controller);
        try {
            const installedPath = await this.cache.install(modelKey, onProgress, controller.signal);
            return { success: true, path: installedPath };
        } catch (error) {
            if (controller.signal.aborted || error.message === 'Download cancelled.') {
                return { success: false, code: 'CANCELLED', error: 'Download cancelled.' };
            }
            const normalized = normalizeError(error);
            return { success: false, code: normalized.code, error: normalized.message };
        } finally {
            if (this.activeDownloads.get(modelKey) === controller) {
                this.activeDownloads.delete(modelKey);
            }
        }
    }

    cancelDownload(modelKey) {
        const controller = this.activeDownloads.get(modelKey);
        if (controller) {
            controller.abort();
            this.activeDownloads.delete(modelKey);
            return true;
        }
        return false;
    }

    cancelAllDownloads() {
        for (const [key, controller] of this.activeDownloads.entries()) {
            controller.abort();
        }
        this.activeDownloads.clear();
    }

    scheduleIdleUnload(delayMs = 20000) {
        this.cancelIdleUnload();
        if (typeof delayMs === 'number' && delayMs > 0) {
            this.idleTimer = setTimeout(() => {
                this.idleTimer = null;
                this.unloadAll().catch(() => {});
            }, delayMs);
        }
    }

    cancelIdleUnload() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    // A deferred eco-unload may be parked on setImmediate after a transcription.
    // Cancel it when a new request arrives so we never free a recognizer that
    // the next transcription is about to (re)use.
    cancelPendingUnload() {
        this._pendingUnload = null;
    }

    async remove(modelKey) {
        this.cancelDownload(modelKey);
        if (this._sherpa?.loaded?.modelKey === modelKey) await this.sherpa.unload();
        await this.cache.remove(modelKey);
        return { success: true };
    }

    async unloadAll() {
        this.cancelIdleUnload();
        this.cancelPendingUnload();
        // Run through the transcription queue so an unload can never free a
        // recognizer while a decode is in flight (settings saves call unloadAll
        // on every change, even mid-transcription).
        const doUnload = async () => {
            if (this._sherpa) await this._sherpa.unload();
        };
        this.queue = this.queue.then(doUnload, doUnload);
        await this.queue;
    }

    // Hygiene: delete model cache entries that are no longer in the registry
    // (e.g. per-language Moonshine models replaced by the multilingual set).
    async cleanupStale() {
        await this.cache.removeStaleModels(Object.keys(this.registry));
    }

    async transcribeLocal({ modelKey, pcm, sampleRate, ecoMode, uiLanguage }) {
        this.cancelIdleUnload();
        this.cancelPendingUnload();
        const model = getModel(modelKey);
        if (!model.verified) throw new Error(model.unavailableReason || 'This model is not available.');
        if (!(await this.cache.isInstalled(modelKey))) throw new Error('Model weights are not downloaded yet.');
        const adapter = this.sherpa;
        const text = await adapter.transcribe(modelKey, pcm, sampleRate, { uiLanguage });

        if (ecoMode !== false) {
            // Eco Mode ON: Unload model off the hot path on next tick so returning text to user is instant.
            // The token makes a stale unload a no-op if a new transcription starts first.
            const token = {};
            this._pendingUnload = token;
            setImmediate(() => {
                if (this._pendingUnload !== token) return;
                this._pendingUnload = null;
                adapter.unload().catch(() => {});
            });
        } else {
            // Eco Mode OFF (Keep Warm): Arm idle unload timer so RAM returns to baseline after inactivity
            const idleWindowMs = (this.idleUnloadSeconds || 20) * 1000;
            this.scheduleIdleUnload(idleWindowMs);
        }
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
