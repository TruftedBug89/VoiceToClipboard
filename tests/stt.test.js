const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { deriveLocalModelKey, migrateConfig, validateSttConfig } = require('../stt/config');
const { getModel, MODEL_REGISTRY } = require('../stt/model-registry');
const { pcmToWav, validatePcm } = require('../stt/audio');
const { ModelCache, downloadFile } = require('../stt/model-cache');
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
    assert.equal(migrated.configVersion, 6);
    assert.equal(migrated.localTier, 'mini');
    assert.equal(migrated.localModelKey, 'mini-multilingual');
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
    assert.equal(migrated.configVersion, 6);
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
    assert.equal(migrated.configVersion, 6);
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
        playFinishSound: true,
        saveRecordings: false,
        outputMode: 'clipboard',
        autotypeMethod: 'unicode',
        micDeviceId: '',
        micDeviceLabel: '',
        historyEnabled: false,
        historyLimit: 50,
        widgetStyle: 'crimson'
    });
    // On a 32 GB machine the invalid tier resolves to Mini (the recommended fast default).
    assert.deepEqual(withRamGB(32, () => validateSttConfig({ sttEngine: 'other', localTier: 'huge' })), {
        sttEngine: 'local',
        localTier: 'mini',
        localLanguage: 'auto',
        localModelKey: 'mini-multilingual',
        geminiModel: 'gemini-2.5-flash',
        ecoMode: true,
        playFinishSound: true,
        saveRecordings: false,
        outputMode: 'clipboard',
        autotypeMethod: 'unicode',
        micDeviceId: '',
        micDeviceLabel: '',
        historyEnabled: false,
        historyLimit: 50,
        widgetStyle: 'crimson'
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
        playFinishSound: true,
        saveRecordings: false,
        outputMode: 'clipboard',
        autotypeMethod: 'unicode',
        micDeviceId: '',
        micDeviceLabel: '',
        historyEnabled: false,
        historyLimit: 50,
        widgetStyle: 'crimson'
    });
});

test('recommends the model tier matching the PC RAM', () => {
    const { recommendedTierForRam } = require('../stt/config');
    assert.equal(recommendedTierForRam(2), 'tiny');
    assert.equal(recommendedTierForRam(4), 'tiny');
    assert.equal(recommendedTierForRam(6), 'mini');
    assert.equal(recommendedTierForRam(8), 'mini');
    assert.equal(recommendedTierForRam(12), 'mini');
    assert.equal(recommendedTierForRam(16), 'mini');
    assert.equal(recommendedTierForRam(24), 'mini');
    assert.equal(recommendedTierForRam(32), 'mini');
    assert.equal(recommendedTierForRam(64), 'mini');
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
    assert.equal(getModel('omni-multilingual').backend, 'whisper');
    assert.equal(getModel('big-multilingual').backend, 'whisper');
    assert.equal(getModel('tiny-multilingual').backend, 'moonshine');
    assert.equal(getModel('mini-multilingual').backend, 'nemo-transducer');
    assert.equal(getModel('zh-en-light').backend, 'sense-voice');
    assert.equal(getModel('zh-en-big').backend, 'fire-red-asr-ctc');
    for (const key of Object.keys(MODEL_REGISTRY)) {
        assert.equal(getModel(key).language, 'auto');
        assert.equal(getModel(key).verified, true);
    }
});

test('every model has a pinned sha256 and full mirror file hashes', () => {
    const HEX64 = /^[0-9a-f]{64}$/;
    for (const [key, model] of Object.entries(MODEL_REGISTRY)) {
        // Every archive must be pinned so integrity checks actually enforce.
        assert.match(model.sha256, HEX64, `${key} must pin a 64-hex archive sha256`);
        assert.ok(Array.isArray(model.expectedFiles) && model.expectedFiles.length > 0, `${key} must list expectedFiles`);

        if (model.mirrorBase) {
            // Per-file mirror downloads must cover every extracted file so a
            // tampered mirror file is rejected before native code loads it.
            assert.ok(model.fileHashes, `${key} must pin per-file mirror hashes`);
            for (const file of model.expectedFiles) {
                assert.match(model.fileHashes[file], HEX64, `${key} must pin a 64-hex hash for ${file}`);
            }
        }
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

test('redacts header-style keys and bare bearer tokens from errors', () => {
    const key = `AIza${'B'.repeat(32)}`;
    const message = sanitizeErrorMessage(new Error(
        `x-goog-api-key: ${key}, api_key=${key}, x-api-key: ${key}, authorization: Bearer ${key}`
    ));
    assert.equal(message.includes(key), false);
    assert.equal(
        message,
        'x-goog-api-key: [REDACTED], api_key=[REDACTED], x-api-key: [REDACTED], authorization: Bearer [REDACTED]'
    );
});

test('model downloads reject non-HTTPS URLs (http and other schemes)', async () => {
    const dest = path.join(os.tmpdir(), 'vtc-download-test.bin');
    // downloadFile must refuse http:// (cleartext) and any non-https scheme
    // before ever opening a socket; redirects to http:// hit the same guard.
    await assert.rejects(() => downloadFile('http://example.com/model.tar.bz2', dest), /https/);
    await assert.rejects(() => downloadFile('ftp://example.com/model.tar.bz2', dest), /https/);
    assert.equal(fs.existsSync(dest), false);
});

test('model integrity verification rejects corrupted archives and files', async () => {
    const { verifyArchiveIntegrity, verifyMirrorFile, hashFile } = require('../stt/model-cache');
    const file = path.join(os.tmpdir(), 'vtc-integrity-test.bin');
    fs.writeFileSync(file, 'fake model bytes');
    const good = await hashFile(file);

    // Matching hash → passes.
    await assert.doesNotReject(() => verifyArchiveIntegrity({ sha256: good }, file));
    // Wrong hash → rejected before the archive is ever extracted.
    await assert.rejects(() => verifyArchiveIntegrity({ sha256: 'f'.repeat(64) }, file), /integrity/);
    // No pinned hash → skips verification (no false rejections today).
    await assert.doesNotReject(() => verifyArchiveIntegrity({}, file));

    // Per-file mirror verification behaves the same.
    await assert.doesNotReject(() => verifyMirrorFile({ fileHashes: { 'model.onnx': good } }, 'model.onnx', file));
    await assert.rejects(() => verifyMirrorFile({ fileHashes: { 'model.onnx': 'f'.repeat(64) } }, 'model.onnx', file), /integrity/);

    fs.rmSync(file, { force: true });
});

test('keeps model cache paths inside the configured cache directory', async () => {
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicetoclipboard-models-'));
    const cache = new ModelCache(modelsDir);
    assert.equal(cache.getPath('omni-multilingual'), path.join(modelsDir, 'omni-multilingual'));
    assert.throws(() => cache.getPath('../outside'), /Invalid model key/);
    fs.rmSync(modelsDir, { recursive: true, force: true });
});

test('rejects modified installed model files during integrity verification', async () => {
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicetoclipboard-models-'));
    const cache = new ModelCache(modelsDir);
    const modelKey = 'omni-multilingual';
    const model = getModel(modelKey);
    const modelDir = cache.getPath(modelKey);
    fs.mkdirSync(modelDir, { recursive: true });
    const fileHashes = {};
    const fileStats = {};
    for (const file of model.expectedFiles) {
        const filePath = path.join(modelDir, file);
        fs.writeFileSync(filePath, `fixture:${file}`);
        const stat = fs.statSync(filePath);
        fileStats[file] = { size: stat.size, mtimeMs: stat.mtimeMs };
    }
    const { hashFile } = require('../stt/model-cache');
    for (const file of model.expectedFiles) fileHashes[file] = await hashFile(path.join(modelDir, file));
    fs.writeFileSync(path.join(modelDir, 'installation.json'), JSON.stringify({ modelKey, fileHashes, fileStats }), 'utf8');
    assert.equal(await cache.verifyInstalled(modelKey), true);
    assert.equal(await cache.verifyInstalled(modelKey), true);
    fs.appendFileSync(path.join(modelDir, model.expectedFiles[0]), 'tampered');
    assert.equal(await cache.verifyInstalled(modelKey), false);
    fs.rmSync(modelsDir, { recursive: true, force: true });
});

test('recovers interrupted model swaps and removes stale downloads', async () => {
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicetoclipboard-models-'));
    const cache = new ModelCache(modelsDir);
    const backupPath = path.join(modelsDir, 'omni-multilingual.backup-test');
    const stalePath = path.join(modelsDir, 'big-multilingual.download-test');
    fs.mkdirSync(backupPath, { recursive: true });
    fs.mkdirSync(stalePath, { recursive: true });
    for (const file of getModel('omni-multilingual').expectedFiles) fs.writeFileSync(path.join(backupPath, file), 'model');

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

test('SttService cancels active model downloads cleanly', async () => {
    const { SttService } = require('../stt/index');
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicetoclipboard-cancel-test-'));
    const service = new SttService({ modelsDir });

    let installStarted = false;
    service.cache.install = (modelKey, onProgress, abortSignal) => {
        installStarted = true;
        return new Promise((resolve, reject) => {
            if (abortSignal) {
                abortSignal.addEventListener('abort', () => reject(new Error('Download cancelled.')), { once: true });
            }
        });
    };

    const downloadPromise = service.download('omni-multilingual');
    assert.equal(service.activeDownloads.has('omni-multilingual'), true);

    const cancelled = service.cancelDownload('omni-multilingual');
    assert.equal(cancelled, true);

    const result = await downloadPromise;
    assert.equal(result.success, false);
    assert.equal(result.code, 'CANCELLED');
    assert.equal(result.error, 'Download cancelled.');
    assert.equal(service.activeDownloads.has('omni-multilingual'), false);

    fs.rmSync(modelsDir, { recursive: true, force: true });
});

test('SttService handles idle unload timer and lazy loading', async () => {
    const { SttService } = require('../stt/index');
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicetoclipboard-idle-test-'));
    const service = new SttService({ modelsDir });

    assert.equal(service._sherpa, null);
    assert.equal(service.idleTimer, null);

    service.scheduleIdleUnload(50);
    assert.notEqual(service.idleTimer, null);

    service.cancelIdleUnload();
    assert.equal(service.idleTimer, null);

    fs.rmSync(modelsDir, { recursive: true, force: true });
});
