// src/main/recordings-store.js
// Saves recorded voice sessions to WAV/WebM on disk and opens the recordings directory.

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { recordingsDir, loadConfig } = require('./config-store');
const { pcmToWav } = require('../../stt/audio');
const { logger } = require('../../logger');

/**
 * Calculates byte length of incoming audio payload regardless of Array or Buffer representation.
 * @param {object} request
 * @returns {number}
 */
function audioPayloadBytes(request) {
    if (!request || typeof request !== 'object') return 0;
    const measure = (value, bytesPerElement) => {
        if (!value) return 0;
        if (typeof value.byteLength === 'number') return value.byteLength;
        if (Array.isArray(value)) return value.length * bytesPerElement;
        return 0;
    };
    if (request.pcm) return measure(request.pcm, 4); // Float32 = 4 bytes per sample
    if (request.arrayBuffer) return measure(request.arrayBuffer, 1);
    return 0;
}

/**
 * Saves recorded audio to disk if enabled in user configuration.
 * @param {object} request Transcription request payload
 * @returns {Promise<string|null>} File path or null
 */
async function saveRecordingAudio(request) {
    if (!request) return null;
    const config = loadConfig();
    if (!config.saveRecordings) return null;
    try {
        await fs.promises.mkdir(recordingsDir, { recursive: true });
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}_${String(now.getMilliseconds()).padStart(3, '0')}`;
        // Same-millisecond saves (e.g. a quick "Transcribe Again" retry) must
        // not silently overwrite each other, so add -1, -2, ... on collision.
        const uniquePath = (base) => {
            let candidate = base;
            for (let n = 2; fs.existsSync(candidate); n++) {
                const ext = path.extname(base);
                candidate = path.join(path.dirname(base), `${path.basename(base, ext)}-${n}${ext}`);
            }
            return candidate;
        };
        let filePath = null;
        if (request.pcm) {
            const pcmData = new Float32Array(request.pcm);
            const wavBuffer = pcmToWav(pcmData, request.sampleRate || 16000);
            filePath = uniquePath(path.join(recordingsDir, `recording_${timestamp}.wav`));
            await fs.promises.writeFile(filePath, wavBuffer);
            logger.info(`[recordings] Saved voice recording WAV: ${filePath} (${wavBuffer.length} bytes)`);
        } else if (request.arrayBuffer) {
            const isWebm = request.mimeType && request.mimeType.includes('webm');
            const ext = isWebm ? 'webm' : 'audio';
            filePath = uniquePath(path.join(recordingsDir, `recording_${timestamp}.${ext}`));
            const buf = Buffer.from(request.arrayBuffer);
            await fs.promises.writeFile(filePath, buf);
            logger.info(`[recordings] Saved voice recording ${ext.toUpperCase()}: ${filePath} (${buf.length} bytes)`);
        }
        return filePath;
    } catch (e) {
        logger.warn(`[recordings] Failed to save recording audio: ${e.message || e}`);
        return null;
    }
}

/**
 * Ensures the recordings folder exists and reveals it in Windows Explorer.
 * @returns {Promise<{success: boolean, path: string}>}
 */
async function openRecordingsFolder() {
    await fs.promises.mkdir(recordingsDir, { recursive: true });
    const error = await shell.openPath(recordingsDir);
    return error ? { success: false, path: recordingsDir, error } : { success: true, path: recordingsDir };
}

module.exports = {
    audioPayloadBytes,
    saveRecordingAudio,
    openRecordingsFolder
};
