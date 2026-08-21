// tests/stores.test.js
// Focused unit tests for src/main/history-store.js and src/main/recordings-store.js.
// PORTABLE_EXECUTABLE_DIR redirects config-store's data root into a temp dir
// set BEFORE the first require, so these tests never touch the real user data.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vtc-stores-test-'));
process.env.PORTABLE_EXECUTABLE_DIR = tmpRoot;
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ saveRecordings: true, historyEnabled: true, historyLimit: 25 }),
    'utf8'
);

const { loadHistory, saveHistory, mutateHistory, listHistory, deleteHistory,
        clearHistory, serializeHistory } = require('../src/main/history-store');
const { historyPath } = require('../src/main/config-store');
const { saveRecordingAudio, audioPayloadBytes } = require('../src/main/recordings-store');

test('saveHistory bounds to the configured limit atomically without leaving .tmp files', async () => {
    // Seeded config sets historyLimit: 25 (validateSttConfig clamps it there).
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `i${i}` }));
    await saveHistory(items);
    const saved = await loadHistory();
    assert.equal(saved.length, 25); // sliced to the configured limit
    const leftovers = fs.readdirSync(path.dirname(historyPath)).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
});

test('mutateHistory serializes concurrent mutations without lost updates', async () => {
    await clearHistory();
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
        mutateHistory(history => { history.push({ id: `k${i}` }); return history; })
    ));
    const after = await loadHistory();
    assert.equal(after.length, 10);
});

test('listHistory filters text/engine/model and tolerates corrupted item fields', async () => {
    await saveHistory([
        { id: '1', text: 'Hello World', engine: 'local', model: 'zipformer' },
        { id: '2', text: 'hola mundo', engine: 'gemini', model: 'gemini-2.5-flash' },
        { id: '3', text: 12345, engine: null, model: undefined }, // corrupt entry must not throw
        { id: '4' }
    ]);
    const hits = await listHistory('world');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, '1');
    const eng = await listHistory('GEMINI'); // case-insensitive
    assert.equal(eng.length, 1);
    const all = await listHistory('');
    assert.equal(all.length, 4); // empty query returns everything, no crash
});

test('deleteHistory removes one id and clearHistory empties the store', async () => {
    await saveHistory([{ id: 'x1' }, { id: 'x2' }]);
    await deleteHistory('x1');
    let items = await loadHistory();
    assert.deepEqual(items.map(i => i.id), ['x2']);
    await clearHistory();
    items = await loadHistory();
    assert.deepEqual(items, []);
});

test('serializeHistory escapes quotes and neutralizes CSV formula injection', () => {
    const items = [{ id: 'h1', ts: 1700000000000, engine: 'local', model: 'm1', lang: 'en',
                     chars: 5, durationMs: 100,
                     text: '=HYPERLINK("http://evil","pwned"); +cmd|\x27 /C calc\x27!A0' }];
    const csv = serializeHistory(items, 'csv');
    const lines = csv.trim().split('\n');
    assert.ok(lines[0].startsWith('id,timestamp,'), 'header row present');
    // Dangerous cells are quoted AND prefixed with an apostrophe.
    assert.ok(csv.includes('"\'=HYPERLINK'), 'formula cell gets the leading-apostrophe guard');
    assert.ok(csv.includes('""http://evil""'), 'embedded quotes doubled');

    // Leading-dash text is also neutralized; numeric columns stay numeric.
    const dashCsv = serializeHistory([{ ts: 0, chars: 7, durationMs: 8, text: '-not-a-formula' }], 'csv');
    assert.ok(dashCsv.includes('"\'-not-a-formula"'));
    assert.ok(dashCsv.includes(',7,'));

    // Invalid/missing timestamps must not crash the export (RangeError).
    const badTs = serializeHistory([{ ts: 'not-a-date', text: 'x' }, { text: 'y' }], 'csv');
    assert.ok(badTs.includes('"",'), 'bad/missing timestamps export as empty quoted cells');
    assert.doesNotThrow(() => serializeHistory([{ ts: undefined }, {}], 'txt'));
    assert.doesNotThrow(() => serializeHistory([{}], 'json'));
});

test('serializeHistory TXT format keeps the transcript blocks', () => {
    const txt = serializeHistory(
        [{ ts: 1700000000000, engine: 'local', model: 'm1', text: 'line1\nline2' }],
        'txt'
    );
    assert.ok(txt.includes('(local/m1)'));
    assert.ok(txt.includes('line1\nline2\n'));
});

test('saveRecordingAudio writes WAV files into the isolated recordings dir', async () => {
    const pcm = new Float32Array(64).fill(0.25);
    const p1 = await saveRecordingAudio({ pcm, sampleRate: 16000 });
    assert.ok(p1 && p1.startsWith(path.join(dataDir, 'recordings')), `unexpected path ${p1}`);
    assert.ok(fs.existsSync(p1));
    // Rapid second save must never silently overwrite the first file.
    const p2 = await saveRecordingAudio({ pcm, sampleRate: 16000 });
    assert.notEqual(p1, p2);
    assert.ok(fs.existsSync(p1) && fs.existsSync(p2));
});

test('saveRecordingAudio respects the disabled flag and measures payloads', async () => {
    assert.equal(await saveRecordingAudio(null), null);
    assert.equal(audioPayloadBytes({ pcm: [0.1, 0.2] }), 8);
    assert.equal(audioPayloadBytes({ arrayBuffer: new ArrayBuffer(9) }), 9);
});
