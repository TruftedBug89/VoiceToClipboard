const SECRET_PATTERNS = [
    [/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]'],
    // Full Authorization headers first: consume scheme + credential together
    // (`Authorization: Basic <base64 user:pass>` must not leave the b64 half).
    [/(authorization\s*[:=]\s*(?:Bearer|Basic|Token)?\s*)[A-Za-z0-9._~+\/=-]{8,}/gi, '$1[REDACTED]'],
    // Query params, including suffixed names (?authkey=, &refresh_token=, ...).
    [/([?&][\w.-]*(?:key|token)=)[^&\s"']+/gi, '$1[REDACTED]'],
    [/((?:key|api[_-]?key|api_key|token|authorization|x-goog-api-key|x-api-key)\s*[:=]\s*(?:Bearer\s+)?)[^\s,;"']+/gi, '$1[REDACTED]'],
    // Scheme-prefixed credentials. Basic covers `Authorization: Basic <base64
    // user:pass>` where the credential itself must never survive redaction.
    [/((?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+\/\-]{8,}/g, '$1[REDACTED]']
];

// Hostile thrown values (throwing toString / Symbol.toPrimitive) must never
// crash the sanitizer itself — it runs inside logger writes and error paths.
function stringifyError(value) {
    try {
        return value?.message || String(value ?? 'Unknown error');
    } catch {
        return 'Unknown error';
    }
}

function sanitizeErrorMessage(error) {
    let message = stringifyError(error);
    // Node wraps network failures in error.cause chains; sanitize each level
    // so a key leaked only in an inner cause is still redacted.
    let cause = error?.cause;
    let depth = 0;
    while (cause && depth < 5) {
        message += ' | ' + stringifyError(cause);
        cause = cause.cause;
        depth++;
    }
    for (const [pattern, replacement] of SECRET_PATTERNS) {
        message = message.replace(pattern, replacement);
    }
    return message;
}

module.exports = { sanitizeErrorMessage };
