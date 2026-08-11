const { readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const roots = ['main.js', 'renderer.js', 'win32.js', 'stt', 'scripts', 'tests'];
const files = [];

function collect(entry) {
    const stat = statSync(entry);
    if (stat.isDirectory()) {
        for (const child of readdirSync(entry)) collect(join(entry, child));
    } else if (entry.endsWith('.js') && !entry.endsWith(join('scripts', 'check-js.js'))) {
        files.push(entry);
    }
}

for (const root of roots) collect(root);
for (const file of files.sort()) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax OK: ${files.length} JavaScript files.`);
