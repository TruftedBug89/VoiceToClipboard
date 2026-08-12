const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const testDir = join(__dirname, '..', 'tests');
const files = readdirSync(testDir)
    .filter(f => f.endsWith('.test.js'))
    .map(f => join(testDir, f));

if (files.length === 0) {
    console.error('No test files found in tests/');
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 0);
