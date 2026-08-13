# VoiceToClipboard STT Tool — AI Agent & Developer Guide

## Project Goal
A lightweight Windows widget that records microphone audio, transcribes it with Gemini or a local offline model, and copies/pastes the result.

## Security Model & Invariants
- Renderer runs with `contextIsolation: true`, `nodeIntegration: false`; the only main↔renderer surface is `window.api` defined in `preload.js` (contextBridge).
- Strict Content Security Policy (CSP) in `index.html`: `script-src 'self'`.
- All CSS is partitioned into `styles/{base,widget,settings,themes}.css`. Themes (Crimson, Ocean, Aurora, Terminal) use `:root[data-widget-style]` overrides in `styles/themes.css`.
- Every log line is redaction-safe via `logger.js` → `stt/error-sanitizer.js`.
- **STRICT MANDATE:** Never process, read, echo, print, log, display, visualize, or output API keys, passwords, or credentials.

---

## Codebase Architecture & File Structure

```
VoiceToClipboard/
├── main.js                     # Lean main process coordinator (<100 lines)
├── src/
│   ├── main/                   # Modular backend subsystems (deep modules)
│   │   ├── config-store.js     # Config I/O, 200ms debounce queue, synchronous flush
│   │   ├── history-store.js    # Thread-safe history storage & export (JSON/CSV/TXT)
│   │   ├── recordings-store.js # Voice recordings file saver (WAV/WebM)
│   │   ├── gemini.js           # Cloud Gemini client, failover ladder, cooldowns
│   │   ├── windows.js          # BrowserWindow management, geometry, click-through hover
│   │   ├── tray.js             # System tray icon, fallback base64, dynamic context menu
│   │   ├── hotkeys.js          # uIOhook keyboard/mouse hooks & recording promise
│   │   ├── delivery.js         # Output router: clipboard, bubble, toast, autotype
│   │   ├── hygiene.js          # Startup cache/log pruning & stale model cleanup
│   │   ├── i18n.js             # Main-process localized strings (en, es, zh)
│   │   └── ipc.js              # Consolidated typed IPC handlers
│   └── renderer/               # Modular frontend subsystems (<300 lines each)
│       ├── i18n.js             # Client-side t(), tr(), data-i18n bindings, hint tooltips
│       ├── audio.js            # Web Audio sounds, mic stream, Float32 16kHz resampler
│       ├── vad.js              # Speech RMS volume, percentiles, live meter, calibrate
│       ├── visualizer.js       # Canvas animation loop for Crimson/Ocean/Aurora/Terminal
│       ├── interaction.js      # Pointer drag, click-through, keyboard hotkey recording
│       ├── settings-ui.js      # Model catalog, download progress, sliders, history UI
│       └── recording.js        # Recording lifecycle (start/stop/cancel), retry logic
├── renderer.js                 # Frontend bootstrap entry point (<60 lines)
├── preload.js                  # Whitelisted contextBridge API (window.api)
├── win32.js                    # Koffi User32 bindings (GetForegroundWindow, SendInput)
├── logger.js                   # Redaction-safe log rotator writing to app.log
├── index.html                  # Widget & Settings UI markup
├── bubble.html                 # Space-to-paste popup markup
├── stt/                        # Core offline STT engine (sherpa-onnx runtime)
│   ├── index.js                # SttService coordinator
│   ├── config.js               # STT config validation & RAM recommendation ladder
│   ├── model-registry.js       # 6 verified multilingual models with sha256 checksums
│   ├── model-cache.js          # Model download pipeline with bzip2/zip & HF mirror
│   ├── sherpa-adapter.js       # Sherpa-onnx runtime adapter for Moonshine/Whisper/etc.
│   ├── audio.js                # PCM validation & Float32-to-WAV serializer
│   ├── threading.js            # CPU core detection & ORT thread pool scheduler
│   └── error-sanitizer.js      # API key / token sanitizer
├── locales/                    # Bundled translation dictionaries (en.json, es.json, zh.json)
├── tests/                      # Fast unit tests for all modules (<500ms)
└── docs/
    └── ARCHITECTURE.md         # System diagram & complete IPC contract reference
```

---

## Development Guidelines for AI Agents

1. **Deep Modules & Clean Responsibilities:**
   - Keep files small, cohesive (<300 lines), and single-purpose.
   - When adding features, place backend logic in `src/main/` and frontend logic in `src/renderer/`.
2. **IPC Channel Integrity:**
   - When introducing new IPC channels, declare them in [preload.js](file:///C:/Users/lavvo/Documents/VoiceToClipboard/preload.js), handle them in [src/main/ipc.js](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/main/ipc.js), and document them in [docs/ARCHITECTURE.md](file:///C:/Users/lavvo/Documents/VoiceToClipboard/docs/ARCHITECTURE.md).
3. **Verification Commands (Always Run Before Finishing):**
   - Run tests: `node scripts/run-tests.js`
   - Run syntax check: `node scripts/check-js.js`
   - Run i18n check: `node scripts/check-i18n.js`
4. **Native Modules & Windows Quirks:**
   - `sherpa-onnx-node`, `koffi`, and `uiohook-napi` are unpacked in `asarUnpack` in `package.json`.
   - On Windows, `unbzip2-stream` + `tar` is required for `.tar.bz2` archives.
   - `koffi-asar-fix.js` redirects `app.asar` to `app.asar.unpacked` for native DLLs.

---

## Common Scripts
- Start App: `npm start`
- Run Tests: `node scripts/run-tests.js` (or `npm test`)
- Check Syntax: `node scripts/check-js.js`
- Check Locales: `node scripts/check-i18n.js`
- Build NSIS Installer: `node scripts/build.js` (or `npm run build`)
- Pack Unpacked Executable: `node scripts/pack.js` (or `npm run pack`)
