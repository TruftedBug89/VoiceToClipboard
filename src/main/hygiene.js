// src/main/hygiene.js
// Startup cache purging, stale model cleanup, and log rotation.

const fs = require('fs');
const path = require('path');
const { canonicalUserDataPath, modelsDir } = require('./config-store');
const { logger } = require('../../logger');

const MAX_CACHE_BYTES = 200 * 1024 * 1024;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const JUNK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function directorySize(dirPath) {
 let total = 0;
 const entries = await fs.promises.readdir(dirPath, { withFileTypes: true }).catch(() => []);
 for (const entry of entries) {
 const full = path.join(dirPath, entry.name);
 try {
 if (entry.isDirectory()) total += await directorySize(full);
 else total += (await fs.promises.stat(full)).size;
 } catch (error) {}
 }
 return total;
}

async function removeOldFiles(dirPath, { olderThanMs = 0, deleteEmptyDirs = false } = {}) {
 const entries = await fs.promises.readdir(dirPath, { withFileTypes: true }).catch(() => []);
 const now = Date.now();
 for (const entry of entries) {
 const full = path.join(dirPath, entry.name);
 try {
 if (entry.isDirectory()) {
 await removeOldFiles(full, { olderThanMs, deleteEmptyDirs });
 if (deleteEmptyDirs && (await fs.promises.readdir(full).catch(() => [null])).length === 0) {
 await fs.promises.rmdir(full).catch(() => {});
 }
 } else if (olderThanMs <= 0 || now - (await fs.promises.stat(full)).mtimeMs > olderThanMs) {
 await fs.promises.rm(full, { force: true }).catch(() => {});
 }
 } catch (error) {}
 }
}

async function cleanupJunk(sttService) {
 // 1. Model cache: entries no longer in the registry
 if (sttService && typeof sttService.cleanupStale === 'function') {
 await sttService.cleanupStale();
 }

 // 2. Stray download archives / partial files in the model cache folder
 const modelEntries = await fs.promises.readdir(modelsDir).catch(() => []);
 for (const name of modelEntries) {
 if (!/\.(tar\.bz2|zip|part|tmp|download|aria2)$/i.test(name)) continue;
 // Skip archives written within the last minute: a download can start
 // while this startup pass runs, and deleting its .part/.download file
 // would corrupt an in-flight transfer.
 const stat = await fs.promises.stat(path.join(modelsDir, name)).catch(() => null);
 if (stat && Date.now() - stat.mtimeMs < 60000) continue;
 await fs.promises.rm(path.join(modelsDir, name), { recursive: true, force: true }).catch(() => {});
 }

 // 3. Crashpad crash dumps older than a week
 await removeOldFiles(path.join(canonicalUserDataPath, 'Crashpad'), { olderThanMs: JUNK_AGE_MS, deleteEmptyDirs: true });

 // 4. Electron caches - cap at 200 MB each
 for (const cacheName of ['Cache', 'Code Cache', 'GPUCache', 'D3DSCache', 'ShaderCache', 'blob_storage']) {
 const cacheDir = path.join(canonicalUserDataPath, cacheName);
 if (!fs.existsSync(cacheDir)) continue;
 try {
 const size = await directorySize(cacheDir);
 if (size > MAX_CACHE_BYTES) {
 await fs.promises.rm(cacheDir, { recursive: true, force: true });
 }
 } catch (error) {}
 }

 // 5. Log files: drop anything older than a week or larger than 5 MB
 const logEntries = await fs.promises.readdir(canonicalUserDataPath).catch(() => []);
 for (const name of logEntries) {
 if (!/\.(log|txt)$/i.test(name)) continue;
 const full = path.join(canonicalUserDataPath, name);
 try {
 const stat = await fs.promises.stat(full);
 if (stat.isFile() && (Date.now() - stat.mtimeMs > JUNK_AGE_MS || stat.size > MAX_LOG_BYTES)) {
 await fs.promises.rm(full, { force: true });
 }
 } catch (error) {}
 }
}

module.exports = {
 MAX_CACHE_BYTES,
 MAX_LOG_BYTES,
 JUNK_AGE_MS,
 directorySize,
 removeOldFiles,
 cleanupJunk
};
