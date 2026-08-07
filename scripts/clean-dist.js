const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const outputPath = path.join(repositoryRoot, 'dist');

if (path.dirname(outputPath) !== repositoryRoot || path.basename(outputPath) !== 'dist') {
    throw new Error('Refusing to clean an unexpected build path.');
}

try {
    fs.rmSync(outputPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch (error) {
    if (error.code === 'EPERM' || error.code === 'EBUSY') {
        throw new Error(`Cannot clean ${outputPath}. Close any running VoiceToClipboard build and retry.`);
    }
    throw error;
}
fs.mkdirSync(outputPath, { recursive: true });
console.log(`Cleaned ${outputPath}`);
