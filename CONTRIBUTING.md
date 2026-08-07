# Contributing to VoiceToClipboard

VoiceToClipboard is a lightweight Windows Electron widget for recording microphone speech and copying transcription to the clipboard.

## Getting started

```bash
git clone https://github.com/YOUR-USERNAME/VoiceToClipboard.git
cd VoiceToClipboard
npm install
npm start
```

The app supports Gemini cloud transcription and three local offline tiers. Local model archives are downloaded into Electron's user-data cache and must not be committed.

## Code structure

- `main.js`: Electron windows, tray, global hotkeys, config migration, clipboard writes, Gemini calls, and the shared local-ASR service.
- `renderer.js`: Web Audio capture, visualizer, VAD/auto-stop, recording lifecycle, click-through behavior, settings interactions, and IPC calls.
- `index.html`: Widget and settings-window UI.
- `stt/`: model registry, cache verification, audio validation, common dispatcher, and Vosk/Sherpa adapters.
- `tests/`: pure unit tests that do not download model archives.

The local service presents one app-level transcription contract while keeping Vosk, Moonshine, and Parakeet model-specific inference adapters. Do not add Whisper-specific chunking or cleanup without a model-specific reason.

## Guidelines

- Keep the app lightweight and Windows-focused.
- Do not introduce ffmpeg or sox for ordinary recording paths.
- Never log, print, or expose API keys.
- Do not bundle downloaded model archives or user config into the installer.
- Preserve the shared recording lifecycle and result contract: `{ success, text }` or `{ success: false, code, error }`.
- Validate model archives before installation and use the user-data cache, not the application directory.
- Test native runtime changes with both regular Node and Electron 43 on Windows x64.
- Remember that Vosk small models are compact on disk but roughly 300 MB at runtime.
- Do not label Moonshine Spanish as ready until its exact native model package is verified.

## Validation

Run the pure tests and syntax checks before packaging:

```bash
npm test
node --check main.js
node --check renderer.js
```

On Windows, also test:

- `npm start` and `npm run pack`.
- Native addon loading from the unpacked executable.
- Tiny English and Spanish model downloads/transcription.
- Verified Moonshine English and Parakeet model loading.
- Missing, partial, corrupt, and interrupted model downloads.
- Recording, global hotkey, auto-stop, Escape cancellation, repeated hotkeys, and clipboard output.
- Settings persistence and power-saving unload behavior.
- Gemini API-key errors without secret leakage.

## Packaging

```bash
npm run pack
npm run build
```

The only configured generated output is `dist/`. Run `npm run clean:dist` to safely clear that directory before a reproducible build. Do not stage `dist/`, `dist_build*/`, installers, blockmaps, model archives, logs, or unpacked Electron output. Releases are uploaded to GitHub Releases only when explicitly requested.
