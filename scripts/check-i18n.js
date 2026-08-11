// Locale parity check: every key present in en.json must exist in es.json and zh.json.
// Exits non-zero and lists the missing keys on failure.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'locales');
const langs = ['en', 'es', 'zh'];
const data = {};
for (const lang of langs) {
    data[lang] = JSON.parse(fs.readFileSync(path.join(dir, `${lang}.json`), 'utf8'));
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
let failed = false;
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
