# VoiceToClipboard STT Tool

## Project Goal
A super simple, lightweight Windows widget that records voice from the microphone, uses the Gemini Multimodal API for Speech-to-Text (STT), and automatically copies the transcribed text to the clipboard. Designed to be memory-efficient and minimal.

## Current State (v1.0.0 — stable)
- **Language/Environment:** Node.js, Electron app (Windows 10/11).
- **Directory:** `C:\Users\lavvo\Documents\VoiceToClipboard`
- **Core files:** `main.js` (main process: window, tray, hotkey, IPC, Gemini transcription, clipboard), `index.html` + `renderer.js` (UI, recording via Web Audio API `MediaRecorder`, custom drag logic, click-through).
- **Dependencies:** `@google/genai` (Gemini), `electron`, `electron-builder` (dev).
- **API Key:** read from `GEMINI_API_KEY` env var or saved via in-app settings (config stored in `userData/config.json`).

## Architecture Notes (keep in mind when editing)
- **Click-through widget:** window starts with `setIgnoreMouseEvents(true, { forward: true })`; renderer toggles it over interactive elements (`#mic-container`, `#top-bar`, `#settings-modal`) via the `set-ignore-mouse` IPC channel.
- **Custom drag:** no `-webkit-app-region` anywhere (it suppresses pointer events). Dragging uses pointer events + `setPointerCapture`, sending throttled deltas over the `drag-window` IPC channel. Quick press (< 5px movement) = toggle record.
- **Recording states:** idle → recording (`#mic-button.recording`, sonar rings, spin ring, visualizer canvas) → transcribing (`#mic-container.transcribing`, fast spin ring, breathing button, busy badge) → done (`show-check` + `✓ COPIED` badge). Cancel discards audio via `cancelPending` flag; Esc key cancels.
- **Transcription:** `transcribe-audio` IPC handler sends base64 `audio/webm` to `gemini-2.5-flash`; response text must be read as property (`response.text`), NOT a function call.
- **Badge feedback:** `setStatus(mode, text)` in renderer.js — modes: `''` (rec), `busy` (spinner), `done` (green), `err` (red), `dim` (no dot).
- **Renderer errors** are forwarded to stdout/app.log via the `console-message` event (new Electron API style — event object only).
- No live subtitles / Web Speech API — removed intentionally.

## Commands
- Run (dev, terminal): `npm start` (or `node_modules\.bin\electron.cmd .`, logs go to `app.log` when redirected)
- Pack unpacked exe (no install, pin-able): `npm run pack` (output `dist\win-unpacked\VoiceToClipboard.exe`)
- Build NSIS installer: `npm run build` (output `dist\VoiceToClipboard-<version>-Setup.exe`)
- Regenerate app icon: `npm run icon` (writes `build/icon.ico` + `build/icon.png`, zero deps)

## Security Rule
DO NOT leak, print, or expose the `GEMINI_API_KEY` in any logs, chat messages, or console outputs.
