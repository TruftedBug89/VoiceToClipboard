const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pcmToWav } = require('../stt/audio');

test('pcmToWav creates a valid WAV file from Float32 PCM', () => {
    const sampleRate = 16000;
    const pcm = new Float32Array([0, 0.5, -0.5, 0.8, -0.8]);
    const wav = pcmToWav(pcm, sampleRate);

    assert.ok(wav instanceof Buffer);
    assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
    assert.strictEqual(wav.toString('ascii', 12, 16), 'fmt ');
    assert.strictEqual(wav.readUInt32LE(24), sampleRate); // sample rate
    assert.strictEqual(wav.readUInt16LE(34), 16); // 16-bit
    assert.strictEqual(wav.toString('ascii', 36, 40), 'data');
    assert.strictEqual(wav.readUInt32LE(40), pcm.length * 2); // payload bytes
});

test('voice recordings directory saves and persists audio files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtc-recordings-test-'));
    const recordingsDir = path.join(tmpDir, 'recordings');
    fs.mkdirSync(recordingsDir, { recursive: true });

    const sampleRate = 16000;
    const pcm = new Float32Array(sampleRate * 2); // 2 seconds of silence/audio
    const wavBuffer = pcmToWav(pcm, sampleRate);

    const timestamp = '2026-08-12_15-56-05_000';
    const filePath = path.join(recordingsDir, `recording_${timestamp}.wav`);
    fs.writeFileSync(filePath, wavBuffer);

    assert.ok(fs.existsSync(filePath));
    const stat = fs.statSync(filePath);
    assert.strictEqual(stat.size, 44 + pcm.length * 2);

    // Verify file is not matched by junk log cleaner (which cleans .log / .txt files)
    assert.strictEqual(/\.(log|txt)$/i.test(filePath), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});
