// stt/ort-preload.js
// Fixes local STT hanging on Windows 11 24H2+ (and any system with a system
// onnxruntime.dll in System32, version ~1.17).
//
// Problem: sherpa-onnx-node's native addon calls LoadLibrary("onnxruntime.dll")
// by BARE NAME. Windows resolves bare names against already-loaded modules and
// System32 BEFORE the addon's own package directory, so the SYSTEM
// onnxruntime 1.17.x gets loaded instead of the package's 1.27.x → the addon
// (built against ORT API 27) reports "requested API version [27] is not
// available" and createAsync() never resolves → transcription hangs forever.
//
// Fix: load the package's onnxruntime.dll by ABSOLUTE PATH before the sherpa
// addon loads. Once a module named onnxruntime.dll is in the process, the
// addon's bare-name LoadLibrary reuses OUR copy (loaded-modules check wins).
//
// MUST run before require('sherpa-onnx-node') executes (i.e. before the
// sherpa-adapter require in stt/index.js).

const path = require('path');
const fs = require('fs');

function resolvePlatformDir() {
    try {
        const sherpaPkg = path.dirname(require.resolve('sherpa-onnx-node/package.json'));
        const dir = path.join(sherpaPkg, '..', 'sherpa-onnx-win-x64');
        return fs.existsSync(path.join(dir, 'onnxruntime.dll')) ? dir : null;
    } catch (e) {
        return null;
    }
}

function preloadOrt() {
    if (process.env.VTC_ORT_PRELOADED === '1') return;
    const dir = resolvePlatformDir();
    if (!dir) return; // nothing to preload; let the native error surface
    try {
        // koffi-asar-fix (applied first) rewrites app.asar → app.asar.unpacked
        // inside koffi.load, so this works in both dev and packaged builds.
        const koffi = require('koffi');
        koffi.load(path.join(dir, 'onnxruntime.dll'));
        // Preload the providers shared lib too (same directory resolution).
        const prov = path.join(dir, 'onnxruntime_providers_shared.dll');
        if (fs.existsSync(prov)) { try { koffi.load(prov); } catch (e) { /* optional */ } }
        process.env.VTC_ORT_PRELOADED = '1';
    } catch (e) {
        // Log quietly; the app must keep running even if this fails.
        try { console.error('[ort-preload] failed:', String(e)); } catch (e2) { /* ignore */ }
    }
}

module.exports = { preloadOrt };
