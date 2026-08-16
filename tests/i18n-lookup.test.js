// Regression test for the i18n flat-key lookup bug. The locale JSON files use
// FLAT keys with literal dots (e.g. "mic.default") plus one nested `appearance`
// object. The renderer lookup() must prefer the exact flat key before falling
// back to dotted traversal for the nested object.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));

// Mirrors src/renderer/i18n.js lookup() exactly.
function lookup(dict, key) {
    const k = String(key);
    if (dict && typeof dict === 'object' && Object.prototype.hasOwnProperty.call(dict, k)) {
        const v = dict[k];
        return typeof v === 'string' ? v : undefined;
    }
    let v = dict;
    for (const part of k.split('.')) {
        if (v && typeof v === 'object' && part in v) v = v[part];
        else return undefined;
    }
    return typeof v === 'string' ? v : undefined;
}

test('i18n lookup resolves flat dotted keys', () => {
    assert.equal(lookup(en, 'mic.default'), 'System default (recommended)');
    assert.equal(typeof lookup(en, 'model.installed'), 'string');
    assert.equal(typeof lookup(en, 'models.fast'), 'string');
    assert.equal(typeof lookup(en, 'status.COPIED'), 'string');
});

test('i18n lookup falls back to nested traversal for the appearance object', () => {
    assert.equal(typeof lookup(en, 'appearance.widgetStyle'), 'string');
    assert.equal(typeof lookup(en, 'appearance.style.crimson'), 'string');
    assert.equal(typeof lookup(en, 'appearance.widgetStyleTooltip'), 'string');
});

test('i18n source keeps the flat-key-first lookup (regression guard)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'i18n.js'), 'utf8');
    assert.match(src, /Object\.prototype\.hasOwnProperty\.call\(dict, k\)/);
});

test('every renderer t()/data-i18n key resolves against en.json', () => {
    const files = [
        'src/renderer/settings-ui.js', 'index.html', 'src/renderer/recording.js',
        'renderer.js', 'src/renderer/interaction.js', 'src/renderer/i18n.js',
    ];
    const keys = new Set();
    for (const f of files) {
        const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
        for (const m of s.matchAll(/data-i18n(?:-[a-z]+)?=["']([^"']+)["']/g)) keys.add(m[1]);
        for (const m of s.matchAll(/\bt\(\s*["']([^"']+)["']/g)) keys.add(m[1]);
    }
    const missing = [];
    for (const k of keys) {
        if (k.endsWith('.')) continue; // dynamic prefix like 'model.'
        if (lookup(en, k) === undefined) missing.push(k);
    }
    assert.deepEqual(missing, []);
});
