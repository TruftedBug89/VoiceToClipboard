// stt/koffi-asar-fix.js
// Fixes "Failed to load shared library: ..." in packaged (asar) Electron builds.
//
// Problem: native DLLs loaded via koffi.load() live under node_modules and are
// unpacked to resources/app.asar.unpacked (see asarUnpack in package.json).
// Inside a packaged app, __dirname points inside resources/app.asar, so
// koffi.load("…/app.asar/node_modules/…/*.dll") fails - Windows cannot load a
// DLL from inside an asar archive (it is not a real directory).
//
// koffi.load() bypasses Electron's asar-aware require(), so we rewrite
// app.asar → app.asar.unpacked in every path passed to koffi.load().
//
// This MUST run before the first koffi.load() on a sherpa-onnx DLL.
// stt/index.js (via ort-preload) requires this first.

const path = require('path');

function applyKoffiAsarFix() {
 // Only meaningful when running from inside a packaged asar.
 if (!process.resourcesPath) return;
 if (process.env.VTC_KOFFI_ASAR_FIXED === '1') return;

 let koffi;
 try {
 koffi = require('koffi');
 } catch {
 return; // sherpa-onnx will surface its own error if koffi is missing
 }

 const sep = path.sep;
 const asarMarker = `${sep}app.asar${sep}`;
 const unpackedMarker = `${sep}app.asar.unpacked${sep}`;

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
