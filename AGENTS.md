# VoiceToClipboard STT Tool

## Project Goal
A lightweight Windows widget that records microphone audio, transcribes it with Gemini or a local offline model, and copies the result to the clipboard.

## Security model (v4.0.0)
- Renderer has `contextIsolation: true`, `nodeIntegration: false`; the only main↔renderer
  surface is the whitelisted `window.api` in `preload.js` (contextBridge). `index.html` has a
  strict CSP (no `unsafe-inline` for scripts or styles).
- CSS is split into `styles/{base,widget,settings,themes}.css`; Widget Styles (Crimson/Ocean/
  Aurora) are `:root[data-widget-style]` overrides in `styles/themes.css`, persisted as
  `widgetStyle` in config and applied live to both windows.
- Every log line is redaction-safe via `logger.js` → `stt/error-sanitizer.js`.

## Current State (v4.0.0)
- **Language/Environment:** Node.js, Electron 43, Windows 10/11.
- **Core files:** `main.js` (windows, tray, hotkeys, config, IPC, STT service, clipboard, startup cleanup), `index.html` + `renderer.js` (widget, settings, Web Audio capture, VAD, visualizer, click-through, Transcribe Again).
- **Cloud STT:** `@google/genai` using `gemini-2.5-flash`.
- **Local STT (multilingual-only, no language selection):** `stt/` main-process service with **six auto-language models** (tier → key → backend): `tiny-multilingual` (nemo-ctc, FastConformer CTC EN/DE/ES/FR, ~98 MB dl), `mini-multilingual` (nemo-transducer, FastConformer Transducer 10-lang, ~102 MB dl), `zh-en-light` (sense-voice, SenseVoice zh/en/yue/ja/ko, ~158 MB dl), `omni-multilingual` (omnilingual, 300M v2, 1600+ langs, ~279 MB dl — the default `light` tier), `big-multilingual` (parakeet, TDT 0.6B v3 INT8, ~465 MB dl), `zh-en-big` (fire-red-asr-ctc, FireRedASR2 zh/en, ~496 MB dl). Measured RAM on load: ~174 / ~187 / ~298 / ~389 / ~691 / ~784 MB. UI ramEstimates add ~1/3 headroom for peak transcription RAM (tiny 250 / mini 270 / zh-light 400 / light 550 / big 950 MB / zh-big 1.1 GB). Legacy per-language Vosk/Moonshine tiers removed; stale cached models are deleted at startup; after the full pipeline validation run only `omni-multilingual` remains in the user cache (the medium tier, ≤500 MB RAM).
- **Transcribe Again:** the last recording is kept in memory only while a retry is possible; a retry button appears on failure and resends the audio with the CURRENT engine (switch engine/key/model, then retry). Audio is cleared on success/new recording/cancel.
- **Hygiene:** startup removes stale model caches, leftover archives, crashpad dumps >7 days, oversized Electron caches, and old log files.
- **Dependencies:** `@google/genai`, `sherpa-onnx-node` (supports `omnilingual` config), `vosk-koffi`, `uiohook-napi`, and archive extraction tooling.
- **API key:** read from `GEMINI_API_KEY` or saved in `userData/config.json`; never log or expose the key.

## Architecture Notes
- **Click-through widget:** the window starts with `setIgnoreMouseEvents(true, { forward: true })`; the renderer re-enables interaction over the mic, top bar, and modal areas through `set-ignore-mouse` IPC.
- **Custom drag (widget):** no `-webkit-app-region`; pointer events and `setPointerCapture` send drag deltas over IPC. A short press toggles recording. The settings window instead uses a native drag region on its header.
- **Recording lifecycle:** idle → starting → recording → transcribing → copied/error. Escape discards the current session. Session IDs prevent stale callbacks from updating a later recording.
- **Audio:** `MediaRecorder` selects a supported WebM codec. Local inference receives validated mono 16 kHz Float32 PCM. Gemini receives the recorded WebM bytes and actual MIME type.
- **All six models are verified:** downloaded through the real install pipeline and transcribed live on Windows x64 (EN/ES samples; Mandarin for the zh-en pair). See `stt/model-registry.js` for exact archives and licenses.
- **Model cache:** verified model archives are installed atomically under Electron `userData/models`; model archives are never committed or bundled into the installer.
- **Archive extraction:** zip (Vosk) uses `yauzl`; `.tar.bz2` (Moonshine/Parakeet) is decompressed with `unbzip2-stream` piped into `tar.Unpack` — npm `tar` alone cannot decode bzip2 (older builds threw `invalid base256 encoding` on every sherpa-onnx model).
- **Settings window:** frameless (`frame: false`), 400×700, resizable; the modal header is the drag region (`-webkit-app-region: drag`) with custom minimize (`minimize-settings-window` IPC) and close buttons.
- **Downloads UI:** a single model card (name, size, RAM, license, status) with inline progress and one Download & Activate / Remove action; there is no separate download modal.
- **Threshold calculator:** `calculateSpeechVolume` (frequency-weighted RMS, fftSize 64, bins 2–23) feeds the live meter (`METER_MAX = 120`) and VAD auto-stop. Auto-calibrate uses percentile stats (p90 noise / p10 speech), spike-tolerant sampling, a configurable 2–5 s phase duration, and a Reset-to-12 button.
- **IPC result contract:** transcription returns `{ success, text }` or `{ success: false, code, error }`. Clipboard writes happen in the main process.
- **Status badge:** `setStatus(mode, text)` uses `busy`, `done`, `err`, and `dim` modes.
- **No live subtitles/Web Speech API:** transcription is batch-on-submit.

## Commands
- Run: `npm start`
- Tests: `npm test`
- Pack unpacked app: `npm run pack` (output `dist/win-unpacked/VoiceToClipboard.exe`)
- Build NSIS installer: `npm run build` (output under `dist/`)
- Clean generated output: `npm run clean:dist`
- Regenerate icon: `npm run icon`

## Security and release rules
- Never leak, print, or expose `GEMINI_API_KEY`.
- Do not commit `node_modules`, model archives, user config, logs, installers, blockmaps, `latest.yml`, `dist/`, or `dist_build*/`.
- Built installers belong in GitHub Releases, not Git. Do not create a release, upload artifacts, push, or commit unless explicitly requested.
- Test native addon loading in both Node and Electron on Windows x64 before shipping a runtime change.
