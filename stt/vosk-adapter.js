const { Model, Recognizer, setLogLevel } = require('vosk-koffi');
const { validatePcm } = require('./audio');

class VoskAdapter {
    constructor(cache) {
        this.cache = cache;
        this.loaded = null;
        setLogLevel(-1);
    }

    async load(modelKey) {
        if (this.loaded?.modelKey === modelKey) return this.loaded;
        await this.unload();
        const modelPath = await this.cache.getInstalledPath(modelKey);
        if (!modelPath) throw new Error('Model weights are not downloaded yet.');
        const model = new Model(modelPath);
        this.loaded = { modelKey, model, modelPath };
        return this.loaded;
    }

    async unload() {
        if (!this.loaded) return;
        this.loaded.model.free();
        this.loaded = null;
    }

    async transcribe(modelKey, pcm, sampleRate = 16000) {
        const samples = validatePcm(pcm, sampleRate);
        const loaded = await this.load(modelKey);
        const recognizer = new Recognizer({ model: loaded.model, sampleRate });
        try {
            const pcm16 = Buffer.allocUnsafe(samples.length * 2);
            for (let i = 0; i < samples.length; i++) {
                const sample = Math.max(-1, Math.min(1, samples[i]));
                pcm16.writeInt16LE(sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), i * 2);
            }
            await recognizer.acceptWaveformAsync(pcm16);
            const result = recognizer.finalResult();
            return (result?.alternatives?.[0]?.text || '').trim();
        } finally {
            recognizer.free();
        }
    }
}

module.exports = { VoskAdapter };
