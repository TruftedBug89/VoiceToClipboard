// Pure-signal tests for the math the renderer relies on (extracted verbatim so the
// rules stay honest). These mirror renderer.js functions; they do NOT import the DOM.
const assert = require('node:assert/strict');
const test = require('node:test');

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[idx];
}

function calculateSpeechVolume(dataArray) {
    let sum = 0;
    let count = 0;
    const startBin = 2;
    const endBin = Math.min(dataArray.length, 24);
    for (let i = startBin; i < endBin; i++) { const val = dataArray[i]; sum += val * val; count++; }
    if (count === 0) return 0;
    return Math.sqrt(sum / count);
}

test('percentile returns 0 for empty input and indexes a sorted series', () => {
    assert.equal(percentile([], 50), 0);
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(s, 0), 1);
    assert.equal(percentile(s, 100), 10);
    assert.ok(percentile(s, 90) >= percentile(s, 10));
});

test('calculateSpeechVolume is an RMS over bins 2..24', () => {
    assert.equal(calculateSpeechVolume(new Uint8Array(8)), 0);
    const zeros = new Uint8Array(32); // bins 2..23 are 0 -> silence
    assert.equal(calculateSpeechVolume(zeros), 0);
    const loud = new Uint8Array(32); for (let i = 2; i < 24; i++) loud[i] = 40;
    assert.equal(calculateSpeechVolume(loud), 40);
});

test('speech above the threshold exceeds noise floor RMS', () => {
    const noise = new Uint8Array(64); for (let i = 2; i < 24; i++) noise[i] = 8;
    const speech = new Uint8Array(64); for (let i = 2; i < 24; i++) speech[i] = 60;
    assert.ok(calculateSpeechVolume(speech) > calculateSpeechVolume(noise));
});
