// tests/sherpa-chunk.test.js
// Unit tests for the local Whisper long-audio chunking helpers and the
// GEMINI_API_KEY environment-refresh registry parser.

const assert = require('node:assert/strict');
const test = require('node:test');
const { whisperChunkPlan, dedupeWhisperOverlap, WHISPER_CHUNK_SECONDS, WHISPER_OVERLAP_SECONDS } = require('../stt/sherpa-adapter');
const { parseRegValue } = require('../src/main/env-refresh');

test('whisperChunkPlan returns a single full range for short audio', () => {
    const sampleRate = 16000;
    const plan = whisperChunkPlan(10 * sampleRate, sampleRate); // 10 s
    assert.deepEqual(plan, [{ start: 0, end: 10 * sampleRate }]);
});

test('whisperChunkPlan splits long audio into ~28s overlapping ranges', () => {
    const sampleRate = 16000;
    const chunkLen = WHISPER_CHUNK_SECONDS * sampleRate;
    const step = (WHISPER_CHUNK_SECONDS - WHISPER_OVERLAP_SECONDS) * sampleRate;

    // 65 s of audio → three chunks, each ≤ 28 s, every sample covered.
    const plan = whisperChunkPlan(65 * sampleRate, sampleRate);
    assert.equal(plan.length, 3);
    assert.equal(plan[0].start, 0);
    assert.equal(plan[0].end, chunkLen);
    assert.equal(plan[1].start, step);
    assert.equal(plan[1].end, chunkLen + step);
    assert.equal(plan[2].end, 65 * sampleRate);

    // No gaps and no range exceeding the chunk window.
    for (let i = 1; i < plan.length; i++) {
        assert.ok(plan[i].start >= plan[i - 1].end - WHISPER_OVERLAP_SECONDS * sampleRate, 'chunks must overlap by ~1s');
        assert.ok(plan[i].end - plan[i].start <= chunkLen, 'no chunk may exceed the 28s window');
    }
    assert.equal(plan[0].start, 0);
    assert.equal(plan[plan.length - 1].end, 65 * sampleRate);
});

test('whisperChunkPlan covers the exact boundary case of one full chunk', () => {
    const sampleRate = 16000;
    const exactly = WHISPER_CHUNK_SECONDS * sampleRate;
    assert.deepEqual(whisperChunkPlan(exactly, sampleRate), [{ start: 0, end: exactly }]);
    // One sample over the window forces a second (overlapping) chunk.
    const plan = whisperChunkPlan(exactly + 1, sampleRate);
    assert.equal(plan.length, 2);
    assert.equal(plan[1].end, exactly + 1);
});

test('dedupeWhisperOverlap removes a repeated prefix matching the previous tail', () => {
    assert.equal(
        dedupeWhisperOverlap('hello world this is a test', 'this is a test and more words'),
        'and more words'
    );
});

test('dedupeWhisperOverlap keeps the current text when there is no clean match', () => {
    assert.equal(
        dedupeWhisperOverlap('completely different sentence', 'the next chunk begins here'),
        'the next chunk begins here'
    );
    assert.equal(dedupeWhisperOverlap('', 'only current'), 'only current');
    assert.equal(dedupeWhisperOverlap('only previous', ''), '');
});

test('parseRegValue extracts REG_SZ and REG_EXPAND_SZ values from reg query output', () => {
    const sz = 'HKEY_CURRENT_USER\\Environment\r\n    GEMINI_API_KEY    REG_SZ    AIzaSyFakeKeyForTesting123\r\n';
    assert.equal(parseRegValue(sz, 'GEMINI_API_KEY'), 'AIzaSyFakeKeyForTesting123');

    const expand = '    GEMINI_API_KEY    REG_EXPAND_SZ    %USERPROFILE%\\key.txt\r\n';
    assert.equal(parseRegValue(expand, 'GEMINI_API_KEY'), '%USERPROFILE%\\key.txt');

    assert.equal(parseRegValue('    SOME_OTHER_KEY    REG_SZ    xyz\r\n', 'GEMINI_API_KEY'), null);
    assert.equal(parseRegValue('', 'GEMINI_API_KEY'), null);
});
