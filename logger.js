// Centralized, redaction-safe logging for the main process.
// Every line is passed through the STT error sanitizer so API keys/tokens can
// never reach app.log. Levels keep noise down while preserving failure detail.
const fs = require('fs');
const path = require('path');
const { sanitizeErrorMessage } = require('./stt/error-sanitizer');

let _logDir = null;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function init(dirPath) {
    _logDir = dirPath;
}

function _file() {
    return _logDir ? path.join(_logDir, 'app.log') : null;
}

function _write(level, msg) {
    try {
        const safe = sanitizeErrorMessage(typeof msg === 'string' ? msg : (msg && msg.message) || String(msg));
        const line = `[${new Date().toISOString()}] [${level}] ${safe}
`;
        const f = _file();
        if (f) fs.appendFileSync(f, line);
        return line.trim();
    } catch (e) { /* logging must never crash the app */ }
    return '';
}

const logger = {
    init,
    info: (m) => _write('INFO', m),
    warn: (m) => _write('WARN', m),
    error: (m) => _write('ERROR', m),
    redact: (m) => sanitizeErrorMessage(typeof m === 'string' ? m : (m && m.message) || String(m)),
    get path() { return _file(); },
};

module.exports = { logger };
