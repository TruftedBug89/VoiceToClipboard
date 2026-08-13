// src/main/history-store.js
// Thread-safe history storage, query filtering, and multi-format export.

const fs = require('fs');
const { dialog } = require('electron');
const { historyPath, loadConfig, getUiLanguage } = require('./config-store');
const { logger } = require('../../logger');

let historyQueue = Promise.resolve();

/**
 * Loads the array of history items from disk.
 * @returns {Promise<Array<object>>}
 */
async function loadHistory() {
    try {
        if (fs.existsSync(historyPath)) {
            const data = await fs.promises.readFile(historyPath, 'utf8');
            const arr = JSON.parse(data);
            if (Array.isArray(arr)) return arr;
        }
    } catch (e) {
        logger.warn(`[history] Failed to load history: ${e.message || e}`);
    }
    return [];
}

/**
 * Saves bounded history array to disk atomically.
 * @param {Array<object>} historyArray
 * @returns {Promise<void>}
 */
async function saveHistory(historyArray) {
    try {
        const limit = loadConfig().historyLimit || 50;
        const bounded = Array.isArray(historyArray) ? historyArray.slice(0, limit) : [];
        const tempPath = `${historyPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        await fs.promises.writeFile(tempPath, JSON.stringify(bounded, null, 2), 'utf8');
        await fs.promises.rename(tempPath, historyPath);
    } catch (e) {
        logger.warn(`[history] Failed to save history: ${e.message || e}`);
    }
}

/**
 * Serializes history mutation operations to prevent lost-update races.
 * @param {(history: Array<object>) => Promise<Array<object>>|Array<object>} mutator
 * @returns {Promise<Array<object>>}
 */
function mutateHistory(mutator) {
    const run = async () => {
        const history = await loadHistory();
        const next = await mutator(history);
        await saveHistory(Array.isArray(next) ? next : history);
        return next;
    };
    const op = historyQueue.then(run, run);
    historyQueue = op.then(() => {}, () => {});
    return op;
}

/**
 * Searches history by text, engine, or model query.
 * @param {string} [query]
 * @returns {Promise<Array<object>>}
 */
async function listHistory(query = '') {
    const history = await loadHistory();
    if (typeof query === 'string' && query.trim()) {
        const q = query.trim().toLowerCase();
        return history.filter(item =>
            (item.text && item.text.toLowerCase().includes(q)) ||
            (item.engine && item.engine.toLowerCase().includes(q)) ||
            (item.model && item.model.toLowerCase().includes(q))
        );
    }
    return history;
}

/**
 * Deletes a single history entry by ID.
 * @param {string} id
 * @returns {Promise<{success: boolean}>}
 */
async function deleteHistory(id) {
    if (!id) return { success: false };
    await mutateHistory(history => history.filter(item => item.id !== id));
    return { success: true };
}

/**
 * Clears all history entries.
 * @returns {Promise<{success: boolean}>}
 */
async function clearHistory() {
    await mutateHistory(() => []);
    return { success: true };
}

/**
 * Exports history to JSON, CSV, or TXT via a native save dialog.
 * @param {Electron.BrowserWindow|null} parentWindow
 * @param {'json'|'csv'|'txt'} [format]
 * @param {Function} [L] Translation helper
 * @returns {Promise<{success: boolean, canceled?: boolean, filePath?: string}>}
 */
async function exportHistory(parentWindow, format = 'json', L = (k) => k) {
    const history = await loadHistory();
    const ext = format === 'csv' ? 'csv' : format === 'txt' ? 'txt' : 'json';
    const filterName = format === 'csv' ? 'CSV Files' : format === 'txt' ? 'Text Files' : 'JSON Files';
    
    // Ensure window reference is valid and not destroyed
    const targetWin = parentWindow && !parentWindow.isDestroyed() ? parentWindow : null;

    const result = await dialog.showSaveDialog(targetWin, {
        title: L('history.export'),
        defaultPath: `vtc_history_${Date.now()}.${ext}`,
        filters: [{ name: filterName, extensions: [ext] }, { name: 'All Files', extensions: ['*'] }]
    });

    if (result.canceled || !result.filePath) return { success: false, canceled: true };

    let content = '';
    if (format === 'json') {
        content = JSON.stringify(history, null, 2);
    } else if (format === 'txt') {
        content = history.map(i => `[${new Date(i.ts).toLocaleString()}] (${i.engine}/${i.model})\n${i.text}\n`).join('\n---\n\n');
    } else if (format === 'csv') {
        const escapeCsv = str => `"${String(str || '').replace(/"/g, '""')}"`;
        const header = 'id,timestamp,engine,model,lang,chars,durationMs,text\n';
        const rows = history.map(i => [
            escapeCsv(i.id),
            escapeCsv(new Date(i.ts).toISOString()),
            escapeCsv(i.engine),
            escapeCsv(i.model),
            escapeCsv(i.lang),
            i.chars || 0,
            i.durationMs || 0,
            escapeCsv(i.text)
        ].join(',')).join('\n');
        content = header + rows;
    }

    await fs.promises.writeFile(result.filePath, content, 'utf8');
    return { success: true, filePath: result.filePath };
}

/**
 * Appends a successful transcription item to history.
 * @param {object} r Result object {success, text, model}
 * @param {object} request Transcription request
 * @param {number} started Timestamp in ms
 * @param {string|null} recordingFile Path to saved recording audio
 */
async function appendTranscriptionToHistory(r, request, started, recordingFile) {
    if (!r || !r.success || !r.text) return;
    const config = loadConfig();
    if (config.historyEnabled === false) return;
    try {
        const item = {
            id: 'hist_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            text: r.text,
            ts: Date.now(),
            engine: request?.engine === 'local' ? 'local' : 'gemini',
            model: r.model || request?.modelKey || config.localModelKey || config.geminiModel || 'gemini-2.5-flash',
            lang: request?.uiLanguage || getUiLanguage(),
            chars: (r.text || '').length,
            durationMs: Date.now() - started,
            recordingFile: recordingFile || null
        };
        await mutateHistory(history => { history.unshift(item); return history; });
    } catch (e) {
        logger.warn(`[history] Failed to append history: ${e.message || e}`);
    }
}

module.exports = {
    loadHistory,
    saveHistory,
    mutateHistory,
    listHistory,
    deleteHistory,
    clearHistory,
    exportHistory,
    appendTranscriptionToHistory
};
