# Contributing to VoiceToClipboard

A lightweight, always-on-top Windows 10/11 widget that records your voice and copies the
transcription to the clipboard via **Gemini (cloud)** or a **local offline model** (sherpa-onnx).

## Prerequisites
- Windows 10/11 (this is a Windows-only app).
- Node.js **22 LTS** and npm.

## Setup
```bash
git clone https://github.com/TruftedBug89/VoiceToClipboard.git
cd VoiceToClipboard
npm ci            # exact dependency install (native modules are prebuilt)
npm start         # launch the widget (Electron)
```
Set `GEMINI_API_KEY` if you want the cloud engine, or open Settings and paste it there.

## Day-to-day commands
| Command | What it does |
|---|---|
| `npm start` | Launch the app |
| `npm test` | Run the unit test suite (`node --test tests/*.test.js`) |
| `npm run check` | Syntax-check every JS file (`scripts/check-js.js`) |
| `npm run check:i18n` | Locale parity check (`scripts/check-i18n.js`) |
| `npm run pack` | Build an unpacked app to `dist/win-unpacked/` |
| `npm run build` | Build the NSIS installer **and** portable `.exe` to `dist/` |
| `npm run clean:dist` | Remove generated build output |
| `npm run icon` | Regenerate `build/icon.ico` |

CI (`.github/workflows/ci.yml`) runs `check` → `check:i18n` → `test` on a Windows runner.

## Code conventions
- **CommonJS** in the main process and STT layer; 4-space indentation; no TypeScript build step.
- Keep the app **lightweight** — do not add ffmpeg/sox or heavy deps to the recording path.
- **Never** log, print, commit, or expose `GEMINI_API_KEY` or model archives. Logs go through
  `logger.js`, which redacts secrets via `stt/error-sanitizer.js`.
- The renderer has **no Node integration**. All main↔renderer traffic goes through the minimal
  `window.api` bridge defined in `preload.js` (contextIsolation + contextBridge).

## Adding an IPC channel
1. In `preload.js`, add a method to the `window.api` object (invoke/send) or the `LISTEN_CHANNELS`
   whitelist (for main→renderer push).
2. In `main.js`, register the `ipcMain.handle(...)`/`ipcMain.on(...)` handler and **validate the
   payload** (type, enum, size) before acting.
3. Call `window.api.<method>(...)` from `renderer.js`.

## Adding or editing translations
Edit all three locale files (`locales/en.json` is the source of truth, plus `es.json`, `zh.json`)
with the **same key set**, then run `npm run check:i18n`. In markup prefer `data-i18n`,
`data-i18n-title`, or `data-i18n-placeholder`; in logic use `t('section.key')`.

## Theming (Widget Style)
Three styles — **Crimson** (default), **Ocean**, **Aurora** — live in `styles/themes.css` as
`:root[data-widget-style="..."]` custom-property overrides. To add one, add an override block with
the same variables and a swatch in `index.html` (`data-style="<name>"`), then whitelist the name in
`main.js` (`widgetStyle`) and `renderer.js` (`applyWidgetStyle`).

## Releasing
`npm run build` produces `VoiceToClipboard-<ver>-Setup.exe` (installer) and
`VoiceToClipboard-<ver>-portable.exe` in `dist/`. **Installers belong in GitHub Releases, not git**
— never commit `dist/`, installers, blockmaps, or `latest.yml`. Only the maintainer publishes releases.
