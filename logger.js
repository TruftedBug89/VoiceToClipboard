// Centralized, redaction-safe logging for the main process.
// Every line is passed through the STT error sanitizer so API keys/tokens are
// redacted before reaching app.log (best-effort). Levels keep noise down
// while preserving failure detail.
const fs = require('fs');
const path = require('path');
const { sanitizeErrorMessage } = require('./stt/error-sanitizer');

let _logDir = null;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function init(dirPath) {
    _logDir = dirPath;
    try { fs.mkdirSync(_logDir, { recursive: true }); } catch (e) {}
}

function _file() {
    return _logDir ? path.join(_logDir, 'app.log') : null;
}

// Roll the live log to app.log.1 once it outgrows MAX_LOG_BYTES so a single
// long session can't grow app.log unbounded (startup cleanup only handles
// oversized logs at launch, not mid-session).
function _rotateIfNeeded(f) {
    try {
        const stat = fs.statSync(f);
        if (!stat.isFile() || stat.size <= MAX_LOG_BYTES) return;
        const rotated = `${f}.1`;
        try { fs.rmSync(rotated, { force: true }); } catch (e) { /* ignore */ }
        fs.renameSync(f, rotated);
    } catch (e) { /* ignore */ }
}

function _write(level, msg) {
    try {
        const safe = sanitizeErrorMessage(typeof msg === 'string' ? msg : (msg && msg.message) || String(msg));
        const line = `[${new Date().toISOString()}] [${level}] ${safe}
`;
        const f = _file();
        if (f) {
            _rotateIfNeeded(f);
            try {
                fs.appendFileSync(f, line);
            } catch (appendError) {
                // The log dir can vanish mid-session (portable drives, manual
                // cleanup). Recreate it once and retry; the outer try still
                // swallows any remaining failure so logging never crashes.
                fs.mkdirSync(path.dirname(f), { recursive: true });
                fs.appendFileSync(f, line);
            }
        }
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
