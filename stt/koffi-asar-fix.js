// stt/koffi-asar-fix.js
// Fixes "Failed to load shared library: ..." in packaged (asar) Electron builds.
//
// Problem: vosk-koffi computes libvosk.dll's path relative to its own __dirname.
// Inside a packaged app, __dirname lives under resources/app.asar, so it asks
// koffi.load() to load "…/app.asar/node_modules/vosk-koffi/bin-win32-x64/libvosk.dll".
// Windows cannot load a DLL from inside an asar archive (it is not a real
// directory), so the app crashes at startup with an "Error" dialog.
//
// The real DLLs are unpacked to resources/app.asar.unpacked (see asarUnpack in
// package.json). koffi.load() bypasses Electron's asar-aware require(), so we
// (1) rewrite app.asar paths to app.asar.unpacked, and
// (2) prepend the real unpacked bin dir to PATH so libvosk.dll's dependent
//     DLLs (libstdc++-6.dll, libgcc_s_seh-1.dll, libwinpthread-1.dll) resolve.
//
// This MUST run before require('vosk-koffi') executes (i.e. before the
// vosk-koffi module body calls koffi.load()). stt/index.js requires this first.

const path = require('path');

function applyKoffiAsarFix() {
    // Only meaningful when running from inside a packaged asar.
    if (!process.resourcesPath) return;
    if (process.env.VTC_KOFFI_ASAR_FIXED === '1') return;

    let koffi;
    try {
        koffi = require('koffi');
    } catch {
        return; // let vosk-koffi surface its own error if koffi is missing
    }

    const sep = path.sep;
    const asarMarker = `${sep}app.asar${sep}`;
    const unpackedMarker = `${sep}app.asar.unpacked${sep}`;

    // 1) Make dependent DLLs findable: prepend unpacked vosk-koffi bin dir to PATH.
    const unpackedBin = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'vosk-koffi',
        `bin-${process.platform}-${process.arch}`
    );
    const pathVar = process.env.Path || process.env.PATH || '';
    if (unpackedBin && !pathVar.split(path.delimiter).includes(unpackedBin)) {
        process.env.Path = unpackedBin + path.delimiter + pathVar;
    }

    // 2) Rewrite asar paths passed to koffi.load() to their unpacked location.
    if (typeof koffi.load === 'function') {
        const originalLoad = koffi.load;
        koffi.load = function (...args) {
            if (args.length && typeof args[0] === 'string' && args[0].includes(asarMarker)) {
                args[0] = args[0].split(asarMarker).join(unpackedMarker);
            }
            return originalLoad.apply(this, args);
        };
        process.env.VTC_KOFFI_ASAR_FIXED = '1';
    }
}

module.exports = { applyKoffiAsarFix };
