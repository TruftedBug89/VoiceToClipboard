const SECRET_PATTERNS = [
    [/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]'],
    [/([?&](?:key|api[_-]?key|token|access[_-]?token)=)[^&\s"']+/gi, '$1[REDACTED]'],
    [/((?:key|api[_-]?key|api_key|token|authorization|x-goog-api-key|x-api-key)\s*[:=]\s*(?:Bearer\s+)?)[^\s,;"']+/gi, '$1[REDACTED]'],
    [/(Bearer\s+)[A-Za-z0-9._~+\/-]{20,}/g, '$1[REDACTED]']
];

function sanitizeErrorMessage(error) {
    let message = error?.message || String(error || 'Unknown error');
    for (const [pattern, replacement] of SECRET_PATTERNS) {
        message = message.replace(pattern, replacement);
    }
    return message;
}

module.exports = { sanitizeErrorMessage };
