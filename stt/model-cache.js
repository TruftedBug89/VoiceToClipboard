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

function downloadFile(url, destination, onProgress, redirectCount = 0) {
    if (!url.startsWith('https:') && !url.startsWith('http:')) {
        return Promise.reject(new Error('Model download URL must be http(s).'));
    }
    if (redirectCount >= 5) {
        return Promise.reject(new Error('Too many redirects during model download.'));
    }
    return new Promise((resolve, reject) => {
        const httpModule = url.startsWith('http:') ? require('http') : https;
        let output = null;

        const cleanupAndReject = (err) => {
            if (output) {
                try { output.destroy(); } catch (e) {}
            }
            reject(err);
        };

        const request = httpModule.get(url, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                try {
                    const targetUrl = new URL(response.headers.location, url).toString();
                    downloadFile(targetUrl, destination, onProgress, redirectCount + 1).then(resolve, cleanupAndReject);
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
            output = fs.createWriteStream(destination);
            response.on('data', chunk => {
                loaded += chunk.length;
                onProgress?.({ loaded, total });
            });
            output.on('error', cleanupAndReject);
            response.on('error', cleanupAndReject);
            output.on('finish', () => output.close(() => resolve()));
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
function headRemoteSize(url, redirectCount = 0) {
    if (redirectCount >= 5) {
        return Promise.reject(new Error('Too many redirects during model mirror probe.'));
    }
    return new Promise((resolve, reject) => {
        const httpModule = url.startsWith('http:') ? require('http') : https;
        const request = httpModule.request(url, { method: 'HEAD' }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                const targetUrl = new URL(response.headers.location, url).toString();
                headRemoteSize(targetUrl, redirectCount + 1).then(resolve, reject);
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

async function extractArchive(archivePath, destination, archiveType = 'tar', expectedFiles = null) {
    // Only extract what the model actually loads. Whisper-style archives bundle
    // fp32 copies of every weight (~1 GB of files we never use); skipping them
    // makes extraction ~3× faster and keeps the installed size honest.
    const filter = expectedFiles && expectedFiles.length ? (entryPath, entry) => {
        if (entry && entry.type === 'Directory') return true;
        return expectedFiles.includes(String(entryPath || '').split('/').pop());
    } : undefined;
    if (archiveType === 'zip') {
        const yauzl = require('yauzl');
        await new Promise((resolve, reject) => {
            yauzl.open(archivePath, { lazyEntries: true }, (error, zipFile) => {
                if (error) return reject(error);
                zipFile.readEntry();
                zipFile.on('entry', entry => {
                    const normalized = path.normalize(entry.fileName);
                    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
                        zipFile.close();
                        reject(new Error('Model archive contains an unsafe path.'));
                        return;
                    }
                    const outputPath = path.join(destination, normalized);
                    if (/\/$/.test(entry.fileName)) {
                        fsp.mkdir(outputPath, { recursive: true }).then(() => zipFile.readEntry(), reject);
                        return;
                    }
                    fsp.mkdir(path.dirname(outputPath), { recursive: true }).then(() => {
                        zipFile.openReadStream(entry, (streamError, stream) => {
                            if (streamError) return reject(streamError);
                            const output = fs.createWriteStream(outputPath);
                            output.on('error', reject);
                            output.on('finish', () => zipFile.readEntry());
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
            const source = fs.createReadStream(archivePath);
            const unpack = new tar.Unpack({ cwd: destination, strict: true, filter });
            source.on('error', reject);
            unpack.on('error', reject);
            unpack.on('finish', resolve);
            source.pipe(bz2()).pipe(unpack);
        });
        return;
    }
    await tar.x({ file: archivePath, cwd: destination, strict: true, filter });
}

async function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const input = fs.createReadStream(filePath);
        input.on('error', reject);
        input.on('data', chunk => hash.update(chunk));
        input.on('end', () => resolve(hash.digest('hex')));
    });
}

class ModelCache {
    constructor(modelsDir) {
        this.modelsDir = path.resolve(modelsDir);
        this.locks = new Map();
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

    async getManifest(modelKey) {
        const installedPath = await this.getInstalledPath(modelKey);
        if (!installedPath) return null;
        try {
            return JSON.parse(await fsp.readFile(path.join(this.getPath(modelKey), MANIFEST_NAME), 'utf8'));
        } catch {
            return null;
        }
    }

    async install(modelKey, onProgress) {
        const model = getModel(modelKey);
        if (!model.verified || !model.archiveName) {
            throw new Error(model.unavailableReason || 'This model package is not available yet.');
        }
        if (await this.isInstalled(modelKey)) return this.getPath(modelKey);
        if (this.locks.has(modelKey)) return this.locks.get(modelKey);

        const operation = this._install(model, onProgress).finally(() => this.locks.delete(modelKey));
        this.locks.set(modelKey, operation);
        return operation;
    }

    async _install(model, onProgress) {
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
        try {
            onProgress?.({ status: 'initiate', file: model.archiveName });
            let mirrorMode = false;
            try {
                await downloadFile(model.downloadUrl, archivePath, data => onProgress?.({
                    status: 'progress',
                    file: model.archiveName,
                    loaded: data.loaded,
                    total: data.total || model.downloadBytes || 0
                }));
                onProgress?.({ status: 'extracting', file: model.archiveName });
                await extractArchive(archivePath, extractedDir, model.archiveType, model.expectedFiles);
            } catch (error) {
                // GitHub release downloads are flaky on some networks (TLS
                // resets). Fall back to per-file downloads from the HF mirror
                // when one is registered for this model.
                if (!model.mirrorBase) throw error;
                if (await pathExists(archivePath)) await fsp.rm(archivePath, { force: true });
                mirrorMode = true;
                await this._downloadMirror(model, extractedDir, onProgress);
            }
            const installedRoot = findModelRoot(extractedDir, model.expectedFiles);
            if (!installedRoot) throw new Error('Downloaded model is missing required files.');

            if (installedRoot === extractedDir) {
                await fsp.cp(extractedDir, stagedDir, { recursive: true, errorOnExist: true });
                await fsp.rm(extractedDir, { recursive: true, force: true });
            } else {
                await fsp.rename(installedRoot, stagedDir);
            }
            await fsp.writeFile(path.join(stagedDir, MANIFEST_NAME), JSON.stringify({
                modelKey: model.key,
                registryVersion: 1,
                expectedFiles: model.expectedFiles,
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
            await fsp.rm(tempDir, { recursive: true, force: true });
            throw error;
        }
    }

    // Per-file fallback download from a Hugging Face mirror repo. Used when
    // the GitHub release archive cannot be downloaded (flaky networks).
    async _downloadMirror(model, destDir, onProgress) {
        const base = model.mirrorBase.replace(/\/+$/, '');
        const sizes = {};
        let totalBytes = 0;
        for (const file of model.expectedFiles) {
            const url = `${base}/${encodeURIComponent(file)}`;
            const size = await headRemoteSize(url);
            sizes[file] = size;
            totalBytes += size;
        }
        for (const file of model.expectedFiles) {
            const url = `${base}/${encodeURIComponent(file)}`;
            const dest = path.join(destDir, file);
            await downloadFile(url, dest, data => onProgress?.({
                status: 'progress',
                file,
                loaded: data.loaded,
                total: data.total || sizes[file] || totalBytes || model.downloadBytes || 0
            }));
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
    hashFile
};
