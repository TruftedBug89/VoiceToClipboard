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
    const tempPath = `${historyPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
        const limit = loadConfig().historyLimit || 50;
        const bounded = Array.isArray(historyArray) ? historyArray.slice(0, limit) : [];
        await fs.promises.writeFile(tempPath, JSON.stringify(bounded, null, 2), 'utf8');
        await fs.promises.rename(tempPath, historyPath);
    } catch (e) {
        logger.warn(`[history] Failed to save history: ${e.message || e}`);
        // Never leak orphaned .tmp files in the user data directory.
        fs.promises.unlink(tempPath).catch(() => {});
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
        const has = (v) => typeof v === 'string' && v.toLowerCase().includes(q);
        return history.filter(item => has(item.text) || has(item.engine) || has(item.model));
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
 * Returns a valid Date for a history timestamp, or null when missing/invalid.
 * @param {*} ts
 * @returns {Date|null}
 */
function safeDate(ts) {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Quotes a CSV cell, doubles embedded quotes, and neutralizes spreadsheet
 * formula injection (=, +, -, @, tab, CR prefixes) per the OWASP cheat sheet.
 * @param {*} value
 * @returns {string}
 */
function csvCell(value) {
    let s = String(value === undefined || value === null ? '' : value).replace(/"/g, '""');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s}"`;
}

/**
 * Serializes history items to JSON, TXT, or CSV text.
 * Exported separately from exportHistory so formats stay unit-testable
 * without Electron dialogs.
 * @param {Array<object>} history
 * @param {'json'|'csv'|'txt'} format
 * @returns {string}
 */
function serializeHistory(history, format) {
    if (format === 'csv') {
        const rows = history.map(i => [
            csvCell(i.id),
            csvCell(safeDate(i.ts) ? safeDate(i.ts).toISOString() : ''),
            csvCell(i.engine),
            csvCell(i.model),
            csvCell(i.lang),
            Number.isFinite(i.chars) ? i.chars : 0,
            Number.isFinite(i.durationMs) ? i.durationMs : 0,
            csvCell(i.text)
        ].join(',')).join('\n');
        return `id,timestamp,engine,model,lang,chars,durationMs,text\n${rows}\n`;
    }
    if (format === 'txt') {
        return history.map(i => {
            const d = safeDate(i.ts);
            return `[${d ? d.toLocaleString() : String(i.ts ?? '')}] (${i.engine}/${i.model})\n${typeof i.text === 'string' ? i.text : ''}\n`;
        }).join('\n---\n\n');
    }
    return JSON.stringify(history, null, 2);
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

    const content = serializeHistory(history, ext);

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
    serializeHistory,
    listHistory,
    deleteHistory,
    clearHistory,
    exportHistory,
    appendTranscriptionToHistory
};
