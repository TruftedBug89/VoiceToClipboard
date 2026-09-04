const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { getModel, MODEL_REGISTRY } = require('./model-registry');

const MANIFEST_NAME = 'installation.json';

function safeModelPath(modelsDir, modelKey) {
 if (!/^[a-z0-9-]+$/.test(modelKey)) throw new Error('Invalid model key.');
 return path.join(modelsDir, modelKey);
}

async function pathExists(filePath) {
 try {
 await fsp.access(filePath);
 return true;
 } catch {
 return false;
 }
}

function usableModelEntry(entryPath) {
 try {
 const stat = fs.statSync(entryPath);
 if (stat.isFile()) return stat.size > 0;
 if (stat.isDirectory()) return fs.readdirSync(entryPath).length > 0;
 } catch {}
 return false;
}

function findModelRoot(directory, expectedFiles) {
 const directMatch = expectedFiles.every(file => usableModelEntry(path.join(directory, file)));
 if (directMatch) return directory;

 const entries = fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : [];
 for (const entry of entries) {
 if (!entry.isDirectory()) continue;
 const candidate = path.join(directory, entry.name);
 if (expectedFiles.every(file => usableModelEntry(path.join(candidate, file)))) return candidate;
 }
 return null;
}

function setLowPriority(enable) {
 try {
 const os = require('os');
 const target = enable ? (os.constants?.priority?.PRIORITY_BELOW_NORMAL || 10) : (os.constants?.priority?.PRIORITY_NORMAL || 0);
 os.setPriority(target);
 } catch (e) { /* ignore on unsupported platforms */ }
}

function downloadFile(url, destination, onProgress, redirectCount = 0, abortSignal = null, inFlightHasher = null) {
 // HTTPS-only: model archives are consumed by native code, so a cleartext
 // download (or an https→http redirect) would be a supply-chain risk.
 // The recursive redirect handling below re-enters this function, so any
 // redirect target that downgrades to http:// is rejected here too.
 if (!url.startsWith('https:')) {
 return Promise.reject(new Error('Model download URL must be https.'));
 }
 if (redirectCount >= 5) {
 return Promise.reject(new Error('Too many redirects during model download.'));
 }
 if (abortSignal?.aborted) {
 return Promise.reject(new Error('Download cancelled.'));
 }
 return new Promise((resolve, reject) => {
 const httpModule = https;
 let output = null;
 let request = null;
 let lastEmit = 0;

 const cleanupAndReject = (err) => {
 if (abortSignal) {
 try { abortSignal.removeEventListener('abort', onAbort); } catch (e) {}
 }
 if (output) {
 try { output.destroy(); } catch (e) {}
 }
 if (request) {
 try { request.destroy(); } catch (e) {}
 }
 try {
 if (fs.existsSync(destination)) fs.unlinkSync(destination);
 } catch (e) {}
 reject(err);
 };

 const onAbort = () => {
 cleanupAndReject(new Error('Download cancelled.'));
 };

 if (abortSignal) {
 abortSignal.addEventListener('abort', onAbort, { once: true });
 }

 request = httpModule.get(url, response => {
 if (abortSignal?.aborted) {
 response.resume();
 cleanupAndReject(new Error('Download cancelled.'));
 return;
 }
 if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
 response.resume();
 try {
 if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
 const targetUrl = new URL(response.headers.location, url).toString();
 downloadFile(targetUrl, destination, onProgress, redirectCount + 1, abortSignal, inFlightHasher).then(resolve, cleanupAndReject);
 } catch (e) {
 cleanupAndReject(e);
 }
 return;
 }
 if (response.statusCode !== 200) {
 response.resume();
 cleanupAndReject(new Error(`Model download failed with HTTP ${response.statusCode}.`));
 return;
 }

 const total = Number(response.headers['content-length']) || 0;
 let loaded = 0;
 // 256 KiB buffer minimizes syscall overhead and disk thrashing
 output = fs.createWriteStream(destination, { highWaterMark: 256 * 1024 });
 response.on('data', chunk => {
 loaded += chunk.length;
 if (inFlightHasher) {
 inFlightHasher.update(chunk);
 }
 const now = Date.now();
 if (now - lastEmit >= 64 || (total > 0 && loaded >= total)) {
 lastEmit = now;
 onProgress?.({ loaded, total });
 }
 });
 output.on('error', cleanupAndReject);
 response.on('error', cleanupAndReject);
 output.on('finish', () => {
 if (abortSignal) {
 try { abortSignal.removeEventListener('abort', onAbort); } catch (e) {}
 }
 output.close(() => {
 if (abortSignal?.aborted) {
 try { if (fs.existsSync(destination)) fs.unlinkSync(destination); } catch (e) {}
 reject(new Error('Download cancelled.'));
 } else {
 resolve({ loaded, total });
 }
 });
 });
 response.pipe(output);
 });
 request.setTimeout(25000, () => {
 request.destroy(new Error('Model download timed out.'));
 });
 request.on('error', cleanupAndReject);
 });
}

// Probe the remote size of a file (HEAD, following redirects). Used to give
// the mirror fallback an accurate per-file progress total.
function headRemoteSize(url, redirectCount = 0, abortSignal = null) {
 if (!url.startsWith('https:')) {
 return Promise.reject(new Error('Model mirror URL must be https.'));
 }
 if (abortSignal?.aborted) {
 return Promise.reject(new Error('Download cancelled.'));
 }
 if (redirectCount >= 5) {
 return Promise.reject(new Error('Too many redirects during model mirror probe.'));
 }
 return new Promise((resolve, reject) => {
 const httpModule = https;
 const request = httpModule.request(url, { method: 'HEAD' }, response => {
 if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
 response.resume();
 const targetUrl = new URL(response.headers.location, url).toString();
 headRemoteSize(targetUrl, redirectCount + 1, abortSignal).then(resolve, reject);
 return;
 }
 response.resume();
 if (response.statusCode !== 200) {
 reject(new Error(`Model mirror probe failed with HTTP ${response.statusCode}.`));
 return;
 }
 resolve(Number(response.headers['content-length']) || 0);
 });
 request.setTimeout(30000, () => request.destroy(new Error('Model mirror probe timed out.')));
 request.on('error', reject);
 request.end();
 });
}

async function extractArchive(archivePath, destination, archiveType = 'tar', expectedFiles = null, abortSignal = null) {
 if (abortSignal?.aborted) throw new Error('Download cancelled.');
 setLowPriority(true);
 try {
 // Only extract what the model actually loads. Whisper-style archives bundle
 // fp32 copies of every weight (~1 GB of files we never use); skipping them
 // makes extraction ~3× faster and keeps the installed size honest.
 const filter = expectedFiles && expectedFiles.length ? (entryPath, entry) => {
 if (entry && entry.type === 'Directory') return true;
 return expectedFiles.includes(String(entryPath || '').split('/').pop());
 } : undefined;
 if (archiveType === 'zip') {
 let yauzl;
 try {
 yauzl = require('yauzl');
 } catch (e) {
 throw new Error('ZIP model support is not available in this build.');
 }
 await new Promise((resolve, reject) => {
 if (abortSignal?.aborted) return reject(new Error('Download cancelled.'));
 yauzl.open(archivePath, { lazyEntries: true }, (error, zipFile) => {
 if (error) return reject(error);
 zipFile.readEntry();
 zipFile.on('entry', entry => {
 if (abortSignal?.aborted) {
 zipFile.close();
 return reject(new Error('Download cancelled.'));
 }
 const normalized = path.normalize(entry.fileName);
 if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
 zipFile.close();
 reject(new Error('Model archive contains an unsafe path.'));
 return;
 }
 const outputPath = path.join(destination, normalized);
 if (/\/$/.test(entry.fileName)) {
 fsp.mkdir(outputPath, { recursive: true }).then(() => {
 setImmediate(() => zipFile.readEntry());
 }, reject);
 return;
 }
 fsp.mkdir(path.dirname(outputPath), { recursive: true }).then(() => {
 zipFile.openReadStream(entry, (streamError, stream) => {
 if (streamError) return reject(streamError);
 const output = fs.createWriteStream(outputPath, { highWaterMark: 256 * 1024 });
 output.on('error', reject);
 output.on('finish', () => {
 setImmediate(() => zipFile.readEntry());
 });
 stream.on('error', reject);
 stream.pipe(output);
 });
 }, reject);
 });
 zipFile.on('end', resolve);
 zipFile.on('error', reject);
 });
 });
 return;
 }
 const tar = require('tar');
 if (archiveType === 'tar.bz2' || /\.tar\.bz2$/i.test(archivePath)) {
 // npm tar has no bzip2 support; decompress the bz2 stream first,
 // then feed the plain tar stream into tar.Unpack.
 const bz2 = require('unbzip2-stream');
 await new Promise((resolve, reject) => {
 if (abortSignal?.aborted) return reject(new Error('Download cancelled.'));
 const source = fs.createReadStream(archivePath, { highWaterMark: 256 * 1024 });
 const unpack = new tar.Unpack({ cwd: destination, strict: true, filter });
 source.on('error', reject);
 unpack.on('error', reject);
 unpack.on('finish', resolve);
 source.pipe(bz2()).pipe(unpack);
 });
 return;
 }
 if (abortSignal?.aborted) throw new Error('Download cancelled.');
 await tar.x({ file: archivePath, cwd: destination, strict: true, filter });
 } finally {
 setLowPriority(false);
 }
}

async function hashFile(filePath) {
 return new Promise((resolve, reject) => {
 const hash = crypto.createHash('sha256');
 const input = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
 input.on('error', reject);
 input.on('data', chunk => hash.update(chunk));
 input.on('end', () => resolve(hash.digest('hex')));
 });
}

// Integrity verification (supply-chain). Pin a known-good sha256 in the
// registry - `model.sha256` for the archive, `model.fileHashes[filename]` for
// mirror per-file downloads. Until a hash is pinned the check is a no-op, so
// installs without hashes keep working; any model WITH a hash is verified and
// rejected on mismatch before it is ever extracted/loaded by native code.
const SHA256_RE = /^[a-f0-9]{64}$/i;

async function verifyArchiveIntegrity(model, archivePath) {
 const expected = model && model.sha256;
 if (!expected || !SHA256_RE.test(String(expected))) return;
 const actual = await hashFile(archivePath);
 if (actual.toLowerCase() !== String(expected).toLowerCase()) {
 throw new Error('Downloaded model archive failed integrity verification.');
 }
}

async function verifyMirrorFile(model, fileName, filePath) {
 const expected = model && model.fileHashes && model.fileHashes[fileName];
 if (!expected || !SHA256_RE.test(String(expected))) return;
 const actual = await hashFile(filePath);
 if (actual.toLowerCase() !== String(expected).toLowerCase()) {
 throw new Error(`Downloaded model file failed integrity verification: ${fileName}`);
 }
}

class ModelCache {
 constructor(modelsDir) {
 this.modelsDir = path.resolve(modelsDir);
 this.locks = new Map();
 this.verificationInflight = new Map();
 }

 getPath(modelKey) {
 return safeModelPath(this.modelsDir, modelKey);
 }

 async prepare() {
 await fsp.mkdir(this.modelsDir, { recursive: true });
 const entries = await fsp.readdir(this.modelsDir, { withFileTypes: true });
 for (const entry of entries) {
 if (entry.name.includes('.download-')) {
 await fsp.rm(path.join(this.modelsDir, entry.name), { recursive: true, force: true });
 continue;
 }
 const backupMarker = '.backup-';
 const markerIndex = entry.name.indexOf(backupMarker);
 if (markerIndex === -1) continue;
 const backupPath = path.join(this.modelsDir, entry.name);
 const modelKey = entry.name.slice(0, markerIndex);
 const finalPath = this.getPath(modelKey);
 if (await pathExists(finalPath)) {
 await fsp.rm(backupPath, { recursive: true, force: true });
 } else {
 await fsp.rename(backupPath, finalPath);
 }
 }

 // Purge installs whose content no longer matches the current registry
 // generation (same key, old archive layout). Prevents stale
 // "installed" states that can never be transcribed and frees disk.
 for (const key of Object.keys(MODEL_REGISTRY)) {
 if (await this.isInstalled(key)) continue;
 const staleDir = this.getPath(key);
 if (await pathExists(staleDir)) {
 await fsp.rm(staleDir, { recursive: true, force: true }).catch(() => {});
 }
 }
 }

 async getInstalledPath(modelKey) {
 const model = getModel(modelKey);
 const root = this.getPath(modelKey);
 if (!(await pathExists(root))) return null;
 return findModelRoot(root, model.expectedFiles);
 }

 async isInstalled(modelKey) {
 return !!(await this.getInstalledPath(modelKey));
 }

 async verifyInstalled(modelKey, { force = false } = {}) {
 if (!force && this.verificationInflight.has(modelKey)) return this.verificationInflight.get(modelKey);
 const operation = this._verifyInstalled(modelKey, { force }).finally(() => this.verificationInflight.delete(modelKey));
 if (!force) this.verificationInflight.set(modelKey, operation);
 return operation;
 }

 async _verifyInstalled(modelKey, { force = false } = {}) {
 const model = getModel(modelKey);
 const installedPath = await this.getInstalledPath(modelKey);
 if (!installedPath) return false;
 const manifest = await this.getManifest(modelKey);
 if (!manifest || manifest.modelKey !== model.key) return false;

 const statMap = {};
 for (const file of model.expectedFiles) {
 const filePath = path.join(installedPath, file);
 const stat = await fsp.stat(filePath).catch(() => null);
 if (!stat || !stat.isFile() || stat.size <= 0) return false;
 statMap[file] = { size: stat.size, mtimeMs: stat.mtimeMs };
 }

 if (!force && manifest.fileStats && model.expectedFiles.every(file => {
 const expected = manifest.fileStats[file];
 const actual = statMap[file];
 return expected && expected.size === actual.size && expected.mtimeMs === actual.mtimeMs;
 })) {
 return true;
 }

 const expectedHashes = manifest.fileHashes || model.fileHashes;
 if (!expectedHashes) return false;
 const actualHashes = {};
 for (const file of model.expectedFiles) {
 const expected = expectedHashes[file];
 if (!expected || !SHA256_RE.test(String(expected))) return false;
 const actual = await hashFile(path.join(installedPath, file));
 if (actual.toLowerCase() !== String(expected).toLowerCase()) return false;
 actualHashes[file] = actual;
 }

 if (!manifest.fileHashes || !manifest.fileStats || force) {
 const upgradedManifest = {
 ...manifest,
 expectedFiles: model.expectedFiles,
 fileHashes: actualHashes,
 fileStats: statMap,
 migratedAt: manifest.fileHashes ? manifest.migratedAt : new Date().toISOString()
 };
 const manifestPath = path.join(this.getPath(modelKey), MANIFEST_NAME);
 const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
 await fsp.writeFile(tempPath, JSON.stringify(upgradedManifest, null, 2), 'utf8');
 await fsp.rename(tempPath, manifestPath);
 }
 return true;
 }

 async getManifest(modelKey) {
 const installedPath = await this.getInstalledPath(modelKey);
 if (!installedPath) return null;
 try {
 return JSON.parse(await fsp.readFile(path.join(this.getPath(modelKey), MANIFEST_NAME), 'utf8'));
 } catch {
 return null;
 }
 }

 async install(modelKey, onProgress, abortSignal = null) {
 const model = getModel(modelKey);
 if (!model.verified || !model.archiveName) {
 throw new Error(model.unavailableReason || 'This model package is not available yet.');
 }
 if (await this.verifyInstalled(modelKey)) return this.getPath(modelKey);
 if (this.locks.has(modelKey)) return this.locks.get(modelKey);

 const operation = this._install(model, onProgress, abortSignal).finally(() => this.locks.delete(modelKey));
 this.locks.set(modelKey, operation);
 return operation;
 }

 async _install(model, onProgress, abortSignal = null) {
 await fsp.mkdir(this.modelsDir, { recursive: true });
 const tempDir = `${this.getPath(model.key)}.download-${process.pid}-${Date.now()}`;
 const archivePath = path.join(tempDir, model.archiveName);
 const extractedDir = path.join(tempDir, 'extracted');
 const stagedDir = path.join(tempDir, 'verified-model');
 const finalDir = this.getPath(model.key);
 const backupDir = `${finalDir}.backup-${process.pid}-${Date.now()}`;
 let movedExisting = false;

 await fsp.rm(tempDir, { recursive: true, force: true });
 await fsp.mkdir(extractedDir, { recursive: true });

 const checkAbort = () => {
 if (abortSignal?.aborted) throw new Error('Download cancelled.');
 };

 try {
 checkAbort();
 onProgress?.({ status: 'initiate', file: model.archiveName });
 let mirrorMode = false;
 try {
 const inFlightHasher = crypto.createHash('sha256');
 await downloadFile(model.downloadUrl, archivePath, data => onProgress?.({
 status: 'progress',
 file: model.archiveName,
 loaded: data.loaded,
 total: data.total || model.downloadBytes || 0
 }), 0, abortSignal, inFlightHasher);
 checkAbort();
 const inFlightDigest = inFlightHasher.digest('hex');
 if (model.sha256 && SHA256_RE.test(String(model.sha256))) {
 if (inFlightDigest.toLowerCase() !== String(model.sha256).toLowerCase()) {
 throw new Error('Downloaded model archive failed integrity verification.');
 }
 } else {
 await verifyArchiveIntegrity(model, archivePath);
 }
 checkAbort();
 onProgress?.({ status: 'extracting', file: model.archiveName });
 await extractArchive(archivePath, extractedDir, model.archiveType, model.expectedFiles, abortSignal);
 checkAbort();
 } catch (error) {
 if (abortSignal?.aborted || error.message === 'Download cancelled.') throw error;
 // GitHub release downloads are flaky on some networks (TLS
 // resets). Fall back to per-file downloads from the HF mirror
 // when one is registered for this model.
 if (!model.mirrorBase) throw error;
 if (await pathExists(archivePath)) await fsp.rm(archivePath, { force: true });
 mirrorMode = true;
 await this._downloadMirror(model, extractedDir, onProgress, abortSignal);
 checkAbort();
 }
 const installedRoot = findModelRoot(extractedDir, model.expectedFiles);
 if (!installedRoot) throw new Error('Downloaded model is missing required files.');

 if (installedRoot === extractedDir) {
 await fsp.cp(extractedDir, stagedDir, { recursive: true, errorOnExist: true });
 await fsp.rm(extractedDir, { recursive: true, force: true });
 } else {
 await fsp.rename(installedRoot, stagedDir);
 }
 checkAbort();
 const fileHashes = {};
 const fileStats = {};
 setLowPriority(true);
 try {
 for (const file of model.expectedFiles) {
 const filePath = path.join(stagedDir, file);
 fileHashes[file] = await hashFile(filePath);
 const stat = await fsp.stat(filePath);
 fileStats[file] = { size: stat.size, mtimeMs: stat.mtimeMs };
 checkAbort();
 await new Promise(r => setImmediate(r));
 }
 } finally {
 setLowPriority(false);
 }
 await fsp.writeFile(path.join(stagedDir, MANIFEST_NAME), JSON.stringify({
 modelKey: model.key,
 registryVersion: 1,
 expectedFiles: model.expectedFiles,
 sha256: model.sha256 || null,
 fileHashes,
 fileStats,
 installedAt: new Date().toISOString()
 }, null, 2), 'utf8');
 await fsp.rm(archivePath, { force: true });

 if (await pathExists(finalDir)) {
 await fsp.rename(finalDir, backupDir);
 movedExisting = true;
 }
 try {
 await fsp.rename(stagedDir, finalDir);
 } catch (error) {
 if (movedExisting && !(await pathExists(finalDir))) {
 await fsp.rename(backupDir, finalDir);
 movedExisting = false;
 }
 throw error;
 }
 if (movedExisting) await fsp.rm(backupDir, { recursive: true, force: true });
 await fsp.rm(tempDir, { recursive: true, force: true });
 onProgress?.({ status: 'verified', modelKey: model.key });
 return finalDir;
 } catch (error) {
 if (movedExisting && !(await pathExists(finalDir)) && await pathExists(backupDir)) {
 await fsp.rename(backupDir, finalDir).catch(() => {});
 }
 await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
 throw error;
 }
 }

 // Per-file fallback download from a Hugging Face mirror repo. Used when
 // the GitHub release archive cannot be downloaded (flaky networks).
 async _downloadMirror(model, destDir, onProgress, abortSignal = null) {
 const base = model.mirrorBase.replace(/\/+$/, '');
 const sizes = {};
 let totalBytes = 0;
 for (const file of model.expectedFiles) {
 if (abortSignal?.aborted) throw new Error('Download cancelled.');
 const url = `${base}/${encodeURIComponent(file)}`;
 const size = await headRemoteSize(url, 0, abortSignal);
 sizes[file] = size;
 totalBytes += size;
 }
 for (const file of model.expectedFiles) {
 if (abortSignal?.aborted) throw new Error('Download cancelled.');
 const url = `${base}/${encodeURIComponent(file)}`;
 const dest = path.join(destDir, file);
 await downloadFile(url, dest, data => onProgress?.({
 status: 'progress',
 file,
 loaded: data.loaded,
 total: data.total || sizes[file] || totalBytes || model.downloadBytes || 0
 }), 0, abortSignal);
 await verifyMirrorFile(model, file, dest);
 }
 }

 async remove(modelKey) {
 if (this.locks.has(modelKey)) await this.locks.get(modelKey).catch(() => {});
 await fsp.rm(this.getPath(modelKey), { recursive: true, force: true });
 }

 // Delete any cached model directory that is no longer in the registry.
 // Keeps the cache folder from growing with abandoned per-language models.
 async removeStaleModels(validKeys) {
 const valid = new Set(validKeys || []);
 const entries = await fsp.readdir(this.modelsDir).catch(() => []);
 for (const entry of entries) {
 if (entry.includes('.download-') || entry.includes('.backup-')) continue;
 if (!/^[a-z0-9-]+$/i.test(entry)) continue;
 if (valid.has(entry)) continue;
 const target = path.join(this.modelsDir, entry);
 const stat = await fsp.stat(target).catch(() => null);
 if (stat && stat.isDirectory()) {
 await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
 }
 }
 }
}

module.exports = {
 ModelCache,
 findModelRoot,
 hashFile,
 downloadFile,
 verifyArchiveIntegrity,
 verifyMirrorFile
};
