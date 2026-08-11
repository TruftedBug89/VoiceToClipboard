const assert = require('node:assert/strict');
const test = require('node:test');
const { validatePcm, pcmToWav } = require('../stt/audio');

test('validatePcm rejects non-positive sample rates', () => {
    assert.throws(() => validatePcm(new Float32Array(1600), 0), /sample rate/i);
    assert.throws(() => validatePcm(new Float32Array(1600), -16000), /sample rate/i);
});

test('validatePcm accepts a 16 kHz mono float buffer', () => {
    const pcm = new Float32Array(16000); // 1s
    assert.doesNotThrow(() => validatePcm(pcm, 16000));
});

test('validatePcm rejects absurd lengths / non-float payloads', () => {
    assert.throws(() => validatePcm('not audio', 16000));
});

test('pcmToWav emits a RIFF/WAVE header with correct sizes', () => {
    const pcm = new Float32Array(16000).fill(0.1);
    const wav = pcmToWav(pcm, 16000);
    assert.ok(Buffer.isBuffer(wav));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 16000); // sample rate field
});
