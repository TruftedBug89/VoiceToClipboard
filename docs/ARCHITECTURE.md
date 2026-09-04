# Architecture

```
┌────────────────────────────────────────────── Electron ──────────────────────────────────────────────┐
│ │
│ MAIN PROCESS (Node.js) RENDERER PROCESS (Chromium Sandbox) │
│ ────────────────────── ──────────────────────────────────── │
│ main.js app coordinator index.html markup │
│ src/main/config-store.js config & debounce queue src/renderer/i18n.js DOM & status i18n │
│ src/main/history-store.js history operations & export src/renderer/audio.js Web Audio & resampler │
│ src/main/recordings-store.js voice audio file saving src/renderer/vad.js speech RMS & calibrate │
│ src/main/gemini.js @google/genai failover src/renderer/visualizer canvas 4 themes │
│ src/main/windows.js widget & settings windows src/renderer/interaction drag & click-through │
│ src/main/tray.js tray icon & context menu src/renderer/settings-ui catalog, modal & forms│
│ src/main/hotkeys.js uIOhook low-level hooks src/renderer/recording.js lifecycle & retries │
│ src/main/delivery.js clipboard/toast/bubble renderer.js bootstrap coordinator │
│ src/main/hygiene.js cache & junk cleanup │
│ src/main/ipc.js typed IPC handlers │
│ │
│ │ ▲ │
│ │ contextBridge (window.api) │ │
│ ▼ ┌────────────────────────────────────────────────────────┐ │ │
│ preload.js whitelist of IPC channels (no nodeIntegration) ────────┘ │
│ │
│ Bubble Overlay: bubble.html + bubble-preload.js + bubble-renderer.js │
│ STT Subsystem: stt/{index,config,model-registry,model-cache,sherpa-adapter,audio,error-sanitizer} │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Security Boundary
- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and a **strict CSP** (`script-src 'self'`).
- The only bridge between the UI and Node.js is `window.api` (whitelisted channels in [preload.js](file:///C:/Users/lavvo/Documents/VoiceToClipboard/preload.js)).
- All API keys and secret tokens are strictly guarded, never logged, and redacted from error objects and diagnostics reports.

---

## Modular Subsystems Map

### Main Process (`src/main/`)
| Module | Responsibility |
| :--- | :--- |
| [`src/main/config-store.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/main/config-store.js) | Config loading, disk debounce queue, user data path resolution, and legacy migration. |
| [`src/main/history-store.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/main/history-store.js) | Atomic serialized history store, query filtering, delete/clear, and multi-format export (JSON/CSV/TXT). |
| [`src/main/recordings-store.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/main/recordings-store.js) | Audio payload measurement, disk saving (`recording_*.wav` or `.webm`), and Explorer open action. |
| [`src/main/gemini.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/main/gemini.js) | Gemini STT transcriber with 5-model failover ladder, 24h quota cooldowns, and prompt localization. |
| [`src/main/windows.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/main/windows.js) | Widget and Settings window creation, geometry validation, click-through hover polling, and snapshot broadcasting. |
| [`src/main/tray.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/main/tray.js) | System tray creation, fallback base64 icon, dynamic menu with Always-on-Top toggle, and cleanup. |
| [`src/main/hotkeys.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/main/hotkeys.js) | Global `uiohook-napi` keyboard and mouse hotkey listeners, keycode translation, and hotkey recording. |
| [`src/main/delivery.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/main/delivery.js) | Output router: clipboard copy, Space-to-paste bubble, toast notification, and autotype/paste injection with Enter simulation. |
| [`src/main/hygiene.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/main/hygiene.js) | Startup cleanup for stale model caches, orphaned archives, Electron caches >200MB, and logs >5MB / 7 days. |
| [`src/main/ipc.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/main/ipc.js) | Typed IPC handler registration connecting renderer calls to backend services. |
| [`src/main/env-refresh.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/main/env-refresh.js) | Re-reads `GEMINI_API_KEY` from the live Windows registry (HKCU/HKLM) and refreshes `process.env` without exposing key material. |

### Renderer Process (`src/renderer/`)
| Module | Responsibility |
| :--- | :--- |
| [`src/renderer/i18n.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/renderer/i18n.js) | UI locale translation `t()`, status message translation `tr()`, DOM `data-i18n` bindings, and floating hint tooltips. |
| [`src/renderer/audio.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/renderer/audio.js) | Web Audio oscillator sound cues (chimes, beeps, error tones), mic stream capture, Float32 16kHz resampler, and device enumeration. |
| [`src/renderer/vad.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/renderer/vad.js) | Speech volume frequency-weighted RMS, percentile math, live noise meter, and auto-calibration routine. |
| [`src/renderer/visualizer.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/renderer/visualizer.js) | Canvas animation loop rendering 4 theme styles: Crimson, Ocean, Aurora, and Terminal. |
| [`src/renderer/interaction.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/renderer/interaction.js) | Custom pointer drag handling (`setPointerCapture`), click-through hover synchronization, and hotkey capture. |
| [`src/renderer/settings-ui.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/renderer/settings-ui.js) | Model catalog dropdown, download progress with ETA, sliders, theme swatches, and history UI. |
| [`src/renderer/recording.js`](file:///C:/Users/lavvo/Documents/VoiceToClipboard/src/renderer/recording.js) | Recording state machine (start, stop, cancel), VAD silence watchdog, transcription dispatch, and Transcribe Again retry. |

---

## IPC Contract Reference

| Channel | Direction | Request Payload | Return Value / Behavior |
| :--- | :--- | :--- | :--- |
| `get-stt-config` | Invoke | none | Returns current settings snapshot object. |
| `save-stt-config` | Invoke | `settings: object` | Persists config, broadcasts updates, returns `{ success }`. |
| `get-model-catalog` | Invoke | none | Returns array of 6 offline models with status and sizes. |
| `download-local-model`| Invoke | `modelKey: string` | Downloads and verifies model archive atomically. |
| `cancel-local-model-download` | Invoke | `modelKey?: string` | Cancels in-flight download stream. |
| `remove-local-model` | Invoke | `modelKey: string` | Deletes local model files from disk. |
| `check-model-downloaded` | Invoke | `modelKey: string` | Returns whether the given model is installed and verified. |
| `get-api-key-status` | Invoke | none | Returns `{ hasKey, count, source }`. |
| `refresh-env-api-key` | Invoke | none | Re-reads `GEMINI_API_KEY` from the Windows registry into `process.env`; returns `{ changed, found }` (booleans only, never key material). |
| `get-gemini-cooldowns` | Invoke | none | Returns `{ keysActive, modelsActive, nextRetryInSec, retryInSec }` (counts only, never key material). |
| `mark-first-run-done` | Invoke | none | Persists `firstRunDone` so the welcome tour never reappears. |
| `save-api-key` | Invoke | `key: string \| string[]` | Saves API key to config. |
| `remove-api-key` | Invoke | none | Clears API key from config. |
| `transcribe-audio` | Invoke | `{ engine, modelKey, pcm, arrayBuffer, mimeType, uiLanguage }` | Returns `{ success: true, text, model, typed }` or error. |
| `get-hotkey` | Invoke | none | Returns formatted hotkey string. |
| `start-recording-hotkey` | Invoke | none | Begins global key/mouse recording; resolves with new hotkey. |
| `history-list` | Invoke | `query?: string` | Returns filtered history items array. |
| `history-delete` | Invoke | `id: string` | Deletes single history item. |
| `history-clear` | Invoke | none | Clears all history items. |
| `history-export` | Invoke | `format: 'json' \| 'csv' \| 'txt'` | Opens native save dialog to export history. |
| `paste-text` | Invoke | `text: string` | Copies to clipboard and pastes to active window. |
| `copy-diagnostics` | Invoke | none | Redacts secrets and copies system diagnostics to clipboard. |
| `open-recordings-folder` | Invoke | none | Opens the recordings folder in Windows Explorer. |
| `renderer-log` | Send | `msg: string` | Redaction-safe renderer log line → `logger.js`. |
| `show-settings-window` | Send | none | Expands the widget window and opens the settings modal. |
| `close-settings-window` | Send | none | Restores widget geometry after the settings modal closes. |
| `bubble-paste` | Send | none | Triggers paste into target window and closes bubble. |
| `bubble-dismiss` | Send | none | Dismisses paste bubble without pasting. |
| `set-ignore-mouse` | Send | `ignore: boolean` | Enables/disables mouse click-through on transparent areas. |
| `drag-start`/`move`/`end` | Send | none | Native window dragging deltas. |
| `widget-raise` | Send | none | Restores always-on-top order for the widget. |

### Main → renderer push channels

| Channel | Payload | Purpose |
| :--- | :--- | :--- |
| `settings-changed` | settings snapshot | Config updated (any source) - renderer refreshes. |
| `models-changed` | model status list | Model download/install state changed. |
| `settings-layout-restored` | none | Widget geometry restored after settings closed - re-sync click-through. |
| `toggle-recording` | none | Global hotkey fired - toggle the recording state machine. |
| `open-settings` | none | Main requested the settings modal (after window expansion). |
| `download-progress` | `{ modelKey, percent, … }` | Live model download progress. |
| `gemini-fallback` | `{ model, keyIndex }` | Gemini failover: the active model/key index after a fallback. |
| `widget-hover` | `{ inside, near, x, y }` | Cursor position relative to the widget window (click-through poll). |
| `bubble-set-text` | `{ text, key, keyLabel, title, style }` | Bubble window: clipped transcript + theme + paste key. |
