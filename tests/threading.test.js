// CPU-lane selection for ONNX Runtime: pure, os-backed logic that must stay
// fast but never overallocate threads (thread-pool contention) or underuse
// many-core CPUs. Requires only node:os, so it is safe to import directly.
const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const { numThreadsFor, physicalCores } = require('../stt/threading');

test('physicalCores is always at least 1', () => {
    assert.ok(physicalCores() >= 1);
});

test('numThreadsFor caps small models at 6 lanes and big/whisper models at 8', () => {
    const cores = os.cpus().length;
    assert.equal(numThreadsFor('moonshine-tiny'), Math.max(2, Math.min(cores, 6)));
    assert.equal(numThreadsFor('fastconformer'), Math.max(2, Math.min(cores, 6)));
    assert.equal(numThreadsFor('whisper-turbo'), Math.max(2, Math.min(cores, 8)));
    assert.equal(numThreadsFor('fire-red-big'), Math.max(2, Math.min(cores, 8)));
});

test('numThreadsFor never drops below 2 and never exceeds physical cores', () => {
    const cores = os.cpus().length;
    for (const key of ['', 'tiny', 'mini', 'whisper-large', 'big', 'unknown-model']) {
        const n = numThreadsFor(key);
        assert.ok(n >= 2, `${JSON.stringify(key)} -> ${n} (>= 2)`);
        assert.ok(n <= cores, `${JSON.stringify(key)} -> ${n} (<= cores ${cores})`);
    }
});

test('big models never get fewer lanes than small models', () => {
    assert.ok(numThreadsFor('whisper-small') >= numThreadsFor('moonshine-tiny'));
    assert.ok(numThreadsFor('big-multilingual') >= numThreadsFor('mini-multilingual'));
});
