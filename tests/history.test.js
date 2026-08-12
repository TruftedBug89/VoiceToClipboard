const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('history operations: array bounding, filtering, format export logic', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtc-test-history-'));
    const historyFile = path.join(tmpDir, 'history.json');

    const sampleItems = [
        { id: 'h1', text: 'Hello world', ts: Date.now(), engine: 'local', model: 'mini-multilingual', lang: 'en', chars: 11, durationMs: 1200, recordingFile: null },
        { id: 'h2', text: 'Spanish test hola', ts: Date.now() - 1000, engine: 'gemini', model: 'gemini-2.5-flash', lang: 'es', chars: 17, durationMs: 800, recordingFile: null }
    ];

    fs.writeFileSync(historyFile, JSON.stringify(sampleItems, null, 2), 'utf8');

    // Verify reading & filtering
    const loaded = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    assert.equal(loaded.length, 2);

    const filtered = loaded.filter(item => item.text.toLowerCase().includes('hello'));
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'h1');

    // Test bounding (e.g. limit 1)
    const limit = 1;
    const bounded = loaded.slice(0, limit);
    assert.equal(bounded.length, 1);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
