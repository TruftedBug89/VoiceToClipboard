const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { deriveLocalModelKey, migrateConfig, validateSttConfig } = require('../stt/config');
const { getModel, MODEL_REGISTRY } = require('../stt/model-registry');
const { pcmToWav, validatePcm } = require('../stt/audio');
const { ModelCache } = require('../stt/model-cache');

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

test('normalizes invalid STT settings to a safe multilingual selection', () => {
    assert.deepEqual(validateSttConfig({ sttEngine: 'other', localTier: 'huge', localLanguage: 'es' }), {
        sttEngine: 'gemini',
        localTier: 'light',
        localLanguage: 'auto',
        localModelKey: 'omni-multilingual',
        geminiModel: 'gemini-2.5-flash',
        ecoMode: true
    });
});

test('preserves any valid tier through validation', () => {
    assert.deepEqual(validateSttConfig({ sttEngine: 'local', localTier: 'zh-light' }), {
        sttEngine: 'local',
        localTier: 'zh-light',
        localLanguage: 'auto',
        localModelKey: 'zh-en-light',
        geminiModel: 'gemini-2.5-flash',
        ecoMode: true
    });
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
