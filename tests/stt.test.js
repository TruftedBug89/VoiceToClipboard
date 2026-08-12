const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { deriveLocalModelKey, migrateConfig, validateSttConfig } = require('../stt/config');
const { getModel, MODEL_REGISTRY } = require('../stt/model-registry');
const { pcmToWav, validatePcm } = require('../stt/audio');
const { ModelCache } = require('../stt/model-cache');
const { sanitizeErrorMessage } = require('../stt/error-sanitizer');

test('derives multilingual model keys (no language selection)', () => {
    assert.equal(deriveLocalModelKey('tiny'), 'tiny-multilingual');
    assert.equal(deriveLocalModelKey('mini'), 'mini-multilingual');
    assert.equal(deriveLocalModelKey('zh-light'), 'zh-en-light');
    assert.equal(deriveLocalModelKey('light'), 'omni-multilingual');
    assert.equal(deriveLocalModelKey('big'), 'big-multilingual');
    assert.equal(deriveLocalModelKey('zh-big'), 'zh-en-big');
    assert.equal(deriveLocalModelKey('invalid'), 'omni-multilingual');
});

test('migrates legacy per-language config to the multilingual registry', () => {
    const migrated = migrateConfig({
        configVersion: 2,
        localTier: 'base',
        localLanguage: 'es',
        localModelKey: 'base-es',
        sttEngine: 'local',
        autoStopSeconds: 4,
        alwaysOnTop: false
    });
    assert.equal(migrated.configVersion, 5);
    assert.equal(migrated.localTier, 'light');
    assert.equal(migrated.localModelKey, 'omni-multilingual');
    assert.equal(migrated.localLanguage, 'auto');
    assert.equal(migrated.autoStopSeconds, 4);
    assert.equal(migrated.alwaysOnTop, false);
    assert.equal(migrated.ecoMode, true);
});

test('migrates legacy Whisper configuration without deleting unrelated settings', () => {
    const migrated = migrateConfig({
        localModel: 'Xenova/whisper-large-v3-turbo',
        sttEngine: 'local',
        autoStopSeconds: 4,
        alwaysOnTop: false
    });
    assert.equal(migrated.configVersion, 5);
    assert.equal(migrated.localModelKey, 'big-multilingual');
    assert.equal(migrated.localTier, 'big');
    assert.equal(migrated.autoStopSeconds, 4);
    assert.equal(migrated.alwaysOnTop, false);
    assert.equal('localModel' in migrated, false);
});

test('keeps zh-en tiers and re-derives model keys on v4 migration', () => {
    const migrated = migrateConfig({
        configVersion: 4,
        localTier: 'zh-big',
        localModelKey: 'big-multilingual',
        sttEngine: 'local'
    });
    assert.equal(migrated.configVersion, 5);
    assert.equal(migrated.localTier, 'zh-big');
    assert.equal(migrated.localModelKey, 'zh-en-big');
    assert.equal(migrated.localLanguage, 'auto');
});

// Deterministic RAM stub so tests don't depend on the host machine's RAM.
function withRamGB(gb, fn) {
    const orig = os.totalmem;
    os.totalmem = () => gb * 1073741824;
    try { return fn(); } finally { os.totalmem = orig; }
}

test('normalizes invalid STT settings to a safe multilingual selection', () => {
    // Unknown engine defaults to LOCAL (offline models are the default engine),
    // and an unknown tier falls back to the model recommended for the PC RAM.
    assert.deepEqual(withRamGB(8, () => validateSttConfig({ sttEngine: 'other', localTier: 'huge', localLanguage: 'es' })), {
        sttEngine: 'local',
        localTier: 'mini',
        localLanguage: 'auto',
        localModelKey: 'mini-multilingual',
        geminiModel: 'gemini-2.5-flash',
        ecoMode: true,
        playFinishSound: true
    });
    // On a 32 GB machine the same invalid tier resolves to Big (tier above default).
    assert.deepEqual(withRamGB(32, () => validateSttConfig({ sttEngine: 'other', localTier: 'huge' })), {
        sttEngine: 'local',
        localTier: 'big',
        localLanguage: 'auto',
        localModelKey: 'big-multilingual',
        geminiModel: 'gemini-2.5-flash',
        ecoMode: true,
        playFinishSound: true
    });
});

test('preserves any valid tier through validation', () => {
    assert.deepEqual(validateSttConfig({ sttEngine: 'local', localTier: 'zh-light' }), {
        sttEngine: 'local',
        localTier: 'zh-light',
        localLanguage: 'auto',
        localModelKey: 'zh-en-light',
        geminiModel: 'gemini-2.5-flash',
        ecoMode: true,
        playFinishSound: true
    });
});

test('recommends the model tier matching the PC RAM', () => {
    const { recommendedTierForRam } = require('../stt/config');
    assert.equal(recommendedTierForRam(2), 'tiny');
    assert.equal(recommendedTierForRam(4), 'tiny');
    assert.equal(recommendedTierForRam(6), 'mini');
    assert.equal(recommendedTierForRam(8), 'mini');
    assert.equal(recommendedTierForRam(12), 'light');
    assert.equal(recommendedTierForRam(16), 'light');
    assert.equal(recommendedTierForRam(24), 'big');
    assert.equal(recommendedTierForRam(32), 'big');
    assert.equal(recommendedTierForRam(64), 'big');
});

test('defaults a fresh config to the LOCAL engine and finish-sound on', () => {
    const migrated = migrateConfig({});
    assert.equal(migrated.sttEngine, 'local');
    assert.equal(migrated.playFinishSound, true);
    assert.equal(migrated.localLanguage, 'auto');
});

test('registry contains the six verified multilingual models', () => {
    assert.deepEqual(Object.keys(MODEL_REGISTRY).sort(), [
        'big-multilingual', 'mini-multilingual', 'omni-multilingual',
        'tiny-multilingual', 'zh-en-big', 'zh-en-light'
    ]);
    assert.equal(getModel('omni-multilingual').backend, 'omnilingual');
    assert.equal(getModel('big-multilingual').backend, 'parakeet');
    assert.equal(getModel('tiny-multilingual').backend, 'nemo-ctc');
    assert.equal(getModel('mini-multilingual').backend, 'nemo-transducer');
    assert.equal(getModel('zh-en-light').backend, 'sense-voice');
    assert.equal(getModel('zh-en-big').backend, 'fire-red-asr-ctc');
    for (const key of Object.keys(MODEL_REGISTRY)) {
        assert.equal(getModel(key).language, 'auto');
        assert.equal(getModel(key).verified, true);
    }
});

test('validates PCM and writes a mono 16-bit WAV header', () => {
    const pcm = new Float32Array([0, -1, 1]);
    assert.equal(validatePcm(pcm, 16000).length, 3);
    const wav = pcmToWav(pcm, 16000);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(34), 16);
});

test('rejects invalid and empty PCM', () => {
    assert.throws(() => validatePcm(new Float32Array(), 16000), /empty/);
    assert.throws(() => validatePcm(new Float32Array([0]), 0), /sample rate/);
    assert.throws(() => validatePcm(new Float32Array([Number.NaN]), 16000), /invalid samples/);
});

test('redacts API keys and authorization values from errors', () => {
    const googleKey = `AIza${'A'.repeat(32)}`;
    const message = sanitizeErrorMessage(new Error(`request failed?key=${googleKey} authorization: Bearer top-secret`));
    assert.equal(message.includes(googleKey), false);
    assert.equal(message.includes('top-secret'), false);
    assert.equal(message, 'request failed?key=[REDACTED] authorization: Bearer [REDACTED]');
});

test('keeps model cache paths inside the configured cache directory', async () => {
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicetoclipboard-models-'));
    const cache = new ModelCache(modelsDir);
    assert.equal(cache.getPath('omni-multilingual'), path.join(modelsDir, 'omni-multilingual'));
    assert.throws(() => cache.getPath('../outside'), /Invalid model key/);
    fs.rmSync(modelsDir, { recursive: true, force: true });
});

test('recovers interrupted model swaps and removes stale downloads', async () => {
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicetoclipboard-models-'));
    const cache = new ModelCache(modelsDir);
    const backupPath = path.join(modelsDir, 'omni-multilingual.backup-test');
    const stalePath = path.join(modelsDir, 'big-multilingual.download-test');
    fs.mkdirSync(backupPath, { recursive: true });
    fs.mkdirSync(stalePath, { recursive: true });
    for (const file of ['model.int8.onnx', 'tokens.txt']) fs.writeFileSync(path.join(backupPath, file), 'model');

    await cache.prepare();

    assert.equal(await cache.isInstalled('omni-multilingual'), true);
    assert.equal(fs.existsSync(stalePath), false);
    assert.equal(fs.existsSync(backupPath), false);
    fs.rmSync(modelsDir, { recursive: true, force: true });
});

test('removes stale model cache entries not in the registry', async () => {
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicetoclipboard-models-'));
    const cache = new ModelCache(modelsDir);
    fs.mkdirSync(path.join(modelsDir, 'base-es'), { recursive: true });
    fs.writeFileSync(path.join(modelsDir, 'base-es', 'encoder_model.ort'), 'model');
    fs.mkdirSync(path.join(modelsDir, 'omni-multilingual'), { recursive: true });
    fs.writeFileSync(path.join(modelsDir, 'omni-multilingual', 'model.int8.onnx'), 'model');
    fs.writeFileSync(path.join(modelsDir, 'omni-multilingual', 'tokens.txt'), 'tokens');

    await cache.removeStaleModels(['omni-multilingual', 'big-multilingual']);

    assert.equal(fs.existsSync(path.join(modelsDir, 'base-es')), false);
    assert.equal(fs.existsSync(path.join(modelsDir, 'omni-multilingual')), true);
    fs.rmSync(modelsDir, { recursive: true, force: true });
});
