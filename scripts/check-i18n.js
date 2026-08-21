// Locale parity check: every key present in en.json must exist in es.json and zh.json.
// Also flags duplicate JSON keys (JSON.parse silently keeps only the last one,
// so a typo'd near-duplicate entry can otherwise shadow the intended value).
// Exits non-zero and lists the problems on failure.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'locales');
const langs = ['en', 'es', 'zh'];
const data = {};
let failed = false;

// Lightweight duplicate-key scan for the pretty-printed locale files
// (one "key": value per line, nested objects indented). Tracks the open
// object stack so identical names in sibling objects are not false positives.
function findDuplicateKeys(raw) {
    const dups = new Set();
    const stack = [new Set()];
    const keyLine = /^\s*"((?:[^"\\]|\\.)*)"\s*:/;
    for (const line of raw.split(/\r?\n/)) {
        const m = line.match(keyLine);
        if (m) {
            const top = stack[stack.length - 1];
            if (top.has(m[1])) dups.add(m[1]);
            else top.add(m[1]);
        }
        const delta = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
        for (let i = 0; i < delta; i++) stack.push(new Set());
        for (let i = 0; i < -delta && stack.length > 1; i++) stack.pop();
    }
    return [...dups];
}

for (const lang of langs) {
    const raw = fs.readFileSync(path.join(dir, `${lang}.json`), 'utf8');
    data[lang] = JSON.parse(raw);
    const dups = findDuplicateKeys(raw);
    if (dups.length) {
        failed = true;
        console.error(`[${lang}] duplicate key(s): ${dups.join(', ')}`);
    }
}

function flatten(obj, prefix = '', out = new Set()) {
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
        else out.add(key);
    }
    return out;
}

const base = flatten(data.en);
for (const lang of langs) {
    if (lang === 'en') continue;
    const other = flatten(data[lang]);
    const missing = [...base].filter(k => !other.has(k));
    const extra = [...other].filter(k => !base.has(k));
    if (missing.length) { failed = true; console.error(`[${lang}] missing ${missing.length} key(s):`); for (const k of missing) console.error(`   - ${k}`); }
    if (extra.length) { console.warn(`[${lang}] has ${extra.length} extra key(s) not in en (ok to keep, but flagged):`); for (const k of extra) console.warn(`   + ${k}`); }
}
if (failed) { console.error('\ni18n parity check FAILED. Align locale files with en.json.'); process.exit(1); }
console.log(`i18n parity OK: ${langs.join(', ')} (${base.size} keys each).`);
