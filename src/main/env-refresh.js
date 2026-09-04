// src/main/env-refresh.js
// Re-reads GEMINI_API_KEY from the live Windows environment so users who
// change the variable in System Properties (or via `setx`) don't have to
// restart the app. Electron snapshots process.env at launch, so this is the
// only way a running app can pick up the change while it stays open.
//
// SECURITY: this module returns booleans only - never the key value. The key
// itself lives in process.env and is consumed by config-store.getApiKeys().
const { execFileSync } = require('child_process');

// User-level vars (HKCU) shadow machine-level ones (HKLM) for a process, so
// check HKCU first and only fall through to HKLM when it isn't set there.
const ENV_HIVES = [
 'HKCU\\Environment',
 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
];

// Parses `reg query` output for a REG_* value. The value name is escaped so
// it is matched literally, and the capture is everything after the type token
// (the value itself may contain spaces).
function parseRegValue(stdout, name) {
 const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const re = new RegExp(`^\\s*${escaped}\\s+REG_[A-Z_]+\\s+(.*?)\\s*$`, 'im');
 const match = String(stdout || '').match(re);
 return match && match[1] ? match[1] : null;
}

function readWindowsEnvVar(name) {
 if (process.platform !== 'win32') return null;
 for (const hive of ENV_HIVES) {
 try {
 const stdout = execFileSync('reg', ['query', hive, '/v', name], {
 encoding: 'utf8',
 windowsHide: true,
 stdio: ['ignore', 'pipe', 'ignore']
 });
 const value = parseRegValue(stdout, name);
 if (value) return value;
 } catch (e) {
 // `reg query` exits non-zero when the value isn't present.
 }
 }
 return null;
}

/**
 * Re-reads GEMINI_API_KEY from the live Windows environment and refreshes
 * process.env so config-store.getApiKeys() sees the new value on the next
 * call. Returns only status booleans - never key material.
 * @returns {{changed: boolean, found: boolean}}
 */
function refreshGeminiApiKeyFromEnvironment() {
 const before = process.env.GEMINI_API_KEY || '';
 // Off Windows there is no registry to consult; never delete the live
 // value just because it cannot be re-read.
 if (process.platform !== 'win32') return { changed: false, found: !!before };
 const fresh = readWindowsEnvVar('GEMINI_API_KEY');
 if (fresh) {
 process.env.GEMINI_API_KEY = fresh;
 } else {
 delete process.env.GEMINI_API_KEY;
 }
 const after = process.env.GEMINI_API_KEY || '';
 return { changed: before !== after, found: !!fresh };
}

module.exports = {
 parseRegValue,
 readWindowsEnvVar,
 refreshGeminiApiKeyFromEnvironment,
 ENV_HIVES
};
