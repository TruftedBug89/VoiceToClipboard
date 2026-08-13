# Architecture

```
┌────────────────────────────  Electron  ────────────────────────────┐
│                                                                    │
│  MAIN PROCESS (Node)                 RENDERER (Chromium, sandboxed) │
│  ──────────────────                  ────────────────────────────   │
│  main.js        windows, tray,       index.html   markup            │
│  logger.js      hotkeys, config,     styles/*.css base/widget/…     │
│  win32.js       clipboard, IPC,      renderer.js  widget logic      │
│                 STT dispatch,        (Web Audio capture, VAD,       │
│                 cleanup              visualizer, settings UI)       │
│        │                                   ▲                        │
│        │  contextBridge  (window.api)      │                        │
│        ▼  ┌─────────────────────────┐      │                        │
│     preload.js  whitelist of IPC ──────────┘                        │
│                 (no nodeIntegration in renderer)                    │
│                                                                    │
│  paste bubble: bubble.html + bubble-preload.js + bubble-renderer.js │
│  STT layer:    stt/{index,config,model-registry,model-cache,        │
│                sherpa-adapter,audio,error-sanitizer}                │
└─────────────────────────────────────────────────────────────────────┘
```

## Security boundary
- The renderer runs with `contextIsolation: true`, `nodeIntegration: false` and a **strict CSP**.
- The only way it talks to privileged code is the typed `window.api` object exposed by
  `preload.js` (invoke/send/on). Channels are whitelisted; payloads are validated in `main.js`.
- Secrets stay in `config.json`/env and are redacted from every log line.

## Data flow (record → clipboard)
1. Renderer captures mic with Web Audio / `MediaRecorder`, runs VAD + the meter.
2. On submit it sends validated mono 16 kHz Float32 PCM (local) or the WebM bytes (Gemini)
   over `transcribe-audio` via `window.api`.
3. `main.js` routes to `SttService` → sherpa-onnx (offline) or `@google/genai` (cloud).
4. The main process writes the result to the clipboard and shows the paste bubble.
