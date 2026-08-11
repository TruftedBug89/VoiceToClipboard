# VoiceToClipboard — Full Application Upgrade Plan

> **Execution note:** This plan is written to be executed by an AI coding agent, phase by phase.
> Each task lists the target files, the concrete change, and how to verify it.
> **Guiding principle:** *Improve every aspect of the app while keeping it a lightweight, always-on-top
> Windows voice-to-clipboard widget with cloud (Gemini) + local (sherpa/vosk) STT.* Do **not** change the core goal,
> do **not** make it heavy, and do **not** break offline/local operation.

---

## 0. Current Architecture Snapshot (as-is)

| Area | File(s) | Notes |
|------|---------|-------|
| Main process | `main.js` (~1110 lines) | BrowserWindows, tray, global hotkeys, `config.json` load/save, IPC handlers, clipboard, Gemini fallback closure, startup cleanup, two always-on `setInterval`s (200ms/500ms), inline `BUBBLE_HTML` blob |
| Renderer | `renderer.js` (~2070 lines) | Widget interaction, Web Audio capture, VAD, canvas visualizer RAF loop, settings load/apply/save, i18n, click-through |
| UI markup + CSS | `index.html` (~1690 lines) | All CSS + all markup inline; single `:root` theme (crimson/red glass); settings modal; **new Widget Style picker markup exists but is not yet wired** |
| Native FFI | `win32.js` (~69 lines) | koffi `user32` calls |
| STT layer | `stt/` | `index.js`, `config.js`, `model-registry.js` (6 models), `model-cache.js` (download/extract/atomic swap), `sherpa-adapter.js`, `vosk-adapter.js`, `audio.js`, `error-sanitizer.js`, `koffi-asar-fix.js`, `ort-preload.js` |
| Tests | `tests/stt.test.js` | Only one test file; `main.js`/`renderer.js` untested |
| Tooling | `scripts/check-js.js` (syntax-only "lint"), `clean-dist.js`, `generate-icon.js` | `npm run check` is a syntax check, **not** a real linter |
| Build | `package.json` → electron-builder | NSIS + portable, Windows only |
| i18n | `locales/en.json`, `es.json`, `zh.json` | |

### Known findings to address (discovered during research)
- **Version mismatch:** `package.json` says `3.1.0`; `AGENTS.md` says `v2.2.0`. Pick a single source of truth.
- **Electron security not hardened:** windows use `nodeIntegration: true` + `contextIsolation: false`, no `preload`/`contextBridge`, and CSP allows `'unsafe-inline'`.
- **Dead UI:** the "Widget Style" swatches were added to `index.html` (~lines 1678–1695) but have **no CSS overrides, no renderer wiring, and no persisted config** — the picker does nothing yet. (Phase 6 finishes this.)
- **Repo clutter:** stray files at root/scripts — `scripts/_inject.txt`, `scripts/_inject_run.js`, `scripts/_inject_widget_style.js`, `scripts/_marker.txt`, the empty root file `60`, `pack-validation.log`, `scan.json`, and generated `dist_build*` / `extract-*` folders — should be removed and git-ignored.
- **Monolith files:** `main.js`, `renderer.js`, `index.html` are very large and mix many responsibilities.
- **`check-js.js` is syntax-only** — no style/lint enforcement, no CI.

---

## Phase 0 — Safety Net (do this first)

**Goal:** make changes safe and reversible before touching anything else.

- [ ] Confirm a clean git state; create a branch `upgrade/phase-0`.
- [ ] Reconcile the version number (choose `package.json` as source of truth; update `AGENTS.md`).
- [ ] Delete scratch/clutter files and add them to `.gitignore`: `scripts/_inject*.{js,txt}`, `scripts/_marker.txt`, root `60`, `scan.json`, `pack-validation.log`, `dist_build*/`, `extract-*/`.
- [ ] Run the existing verification to capture a baseline.

**Verify:**
```bash
npm run check   # syntax OK
npm test        # existing stt tests pass
git status      # only intended files changed
```

---

## Phase 1 — Security Hardening (Electron best practices)

**Goal:** close the biggest risk surface without changing UX.

- [ ] Introduce a `preload.js` and switch every `BrowserWindow` in `main.js` to `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` where feasible.
- [ ] Expose only the specific IPC channels the renderer needs through `contextBridge.exposeInMainWorld` (a typed, minimal API). Refactor `renderer.js` to call `window.api.*` instead of `require('electron').ipcRenderer` directly.
- [ ] Tighten the CSP in `index.html`: remove `'unsafe-inline'` by moving inline `<style>`/`<script>` to external files (see Phase 2); restrict `connect-src`/`img-src`/`media-src` to exactly what's needed.
- [ ] Validate/whitelist **all** IPC payloads in `main.js` handlers (sizes, enums, types).
- [ ] Audit API-key handling: never log keys, keep them only in `config.json`/env, and confirm they never reach renderer memory unnecessarily.

**Verify:** app still records, transcribes (Gemini + local), and pastes; no CSP violations in devtools console; `nodeIntegration` disabled confirmed.

---

## Phase 2 — Architecture & Modularization

**Goal:** break the three monoliths into focused modules without behavior change.

- [ ] `main.js` → split into `main/` modules: `windows.js`, `tray.js`, `hotkeys.js`, `config.js`, `ipc.js`, `clipboard.js`, `cleanup.js`, `gemini.js`. Keep `main.js` as a thin composition root.
- [ ] `index.html` → extract CSS to `styles/` (`base.css`, `widget.css`, `settings.css`, `themes.css`) and markup where practical; enables strict CSP.
- [ ] `renderer.js` → split into `renderer/` modules: `audio-capture.js`, `vad.js`, `visualizer.js`, `settings-ui.js`, `i18n.js`, `widget.js`.
- [ ] Adopt a build/bundle step only if it stays lightweight (esbuild) — optional; prefer plain ES modules if it works with the CSP.

**Verify:** `npm run check`, `npm test`, and a manual smoke run behave identically to Phase 0 baseline.

---

## Phase 3 — Testing & CI

**Goal:** stop relying on a single test file.

- [ ] Add unit tests for pure logic: config load/merge defaults, `error-sanitizer`, `model-registry`/`model-cache` selection, VAD/threshold math (`calculateSpeechVolume`).
- [ ] Add tests around IPC handler validation (mock `ipcMain`).
- [ ] Add a smoke/integration test that launches Electron headlessly and asserts the widget window loads (e.g. `@electron/test` or Playwright-Electron).
- [ ] Add **GitHub Actions** workflow: on push/PR run `npm ci`, `npm run check`, `npm test` on Windows runner.

**Verify:** CI is green; coverage of `stt/` and config logic meaningfully increases.

---

## Phase 4 — Error Handling, Logging & Observability

- [ ] Centralize logging (leveled, redaction-safe) in one module used by both processes.
- [ ] Wrap all async IPC handlers and STT calls in structured try/catch that return the existing `{ success, code, error }` contract; ensure user-facing errors are sanitized (`error-sanitizer.js`).
- [ ] Add a global `unhandledRejection`/`uncaughtException` handler in `main.js` that logs and shows a non-fatal status badge instead of crashing.
- [ ] Add a "copy diagnostics" action in settings that dumps sanitized config + last error (no keys).

**Verify:** forced failures (bad key, missing model, mic denied) surface friendly messages and never leak secrets.

---

## Phase 5 — Performance & Memory

- [ ] Audit the two always-on `setInterval`s in `main.js`; replace polling with event-driven logic or throttle when idle.
- [ ] Ensure the visualizer RAF loop in `renderer.js` fully stops when not recording and when the widget is hidden.
- [ ] Verify local STT model lifecycle: Power-Saving Mode frees RAM after transcription; confirm no buffer leaks in the audio pipeline (Float32 PCM buffers released).
- [ ] Lazy-load heavy `stt` adapters only when a local engine is actually used.

**Verify:** measure idle CPU (~0%), idle RAM, and peak transcription RAM before/after; no growth across repeated recordings.

---

## Phase 6 — UX / Accessibility / **Widget Styles (finish the feature)**

**Goal:** finish the multi-theme feature the user asked for, and improve a11y.

- [ ] **Complete the Widget Style picker** (currently dead markup in `index.html`): add three selectable styles — keep the current **Crimson** as default, plus two new ones **Ocean** and **Aurora** — at the bottom of the settings window.
  - `index.html`/`themes.css`: add CSS variable override sets, e.g. `:root[data-widget-style="ocean"] { --primary: …; --primary-hover: …; --bg-glass: …; --border-glass: …; --text-dim: …; }` and one for `aurora`; default `crimson` keeps the existing `:root` values. Add `.style-picker`/`.style-swatch` styling and an `active` state.
  - `renderer.js`: on config snapshot load, apply `document.documentElement.setAttribute('data-widget-style', style)` and mark the active swatch; add click handlers that set the attribute, update `aria-checked`, and call `autoSaveSettings()`.
  - `main.js`: add a `widgetStyle` field (whitelist `'crimson' | 'ocean' | 'aurora'`, default `'crimson'`) to `loadConfig` defaults, `getSettingsSnapshot`, and the `save-stt-config` handler, mirroring `idleFadeEnabled`.
  - Include `widgetStyle` in the `autoSaveSettings()` payload and hydrate it in `refreshSettingsUi()`.
  - Live-sync: the `settings-changed` IPC → `applyAppearanceSnapshot(snapshot)` path already updates the widget window live; apply `widgetStyle` there too so the floating widget recolors instantly.
  - `locales/{en,es,zh}.json`: add `appearance.widgetStyle`, `appearance.style.crimson`, `appearance.style.ocean`, `appearance.style.aurora`.
- [ ] Accessibility: full keyboard navigation for the settings modal and swatches (arrow keys within the radiogroup), visible focus rings, correct ARIA roles, and honor `prefers-reduced-motion` (disable the mic pulse/sonar animations).
- [ ] Polish empty/loading/error states in the settings model card.

**Verify:** switching styles instantly recolors both the widget and settings windows, persists across restart, and the picker is keyboard- and screen-reader-navigable.

---

## Phase 7 — Internationalization Completeness

- [ ] Extract any remaining hardcoded English strings (in `index.html` inline text and `renderer.js`) into the locale files.
- [ ] Add a check (script or test) that fails when a key exists in `en.json` but is missing in `es.json`/`zh.json`.
- [ ] Verify RTL-readiness is not needed for current langs, but keep the i18n API ready for new locales.

**Verify:** switching UI language leaves no untranslated strings; key-parity check passes.

---

## Phase 8 — Build, Packaging & Auto-Update

- [ ] Confirm `asarUnpack`/`files` globs in `package.json` still include all runtime assets after Phase 2 refactor (new `styles/`, `preload.js`, `main/`, `renderer/`).
- [ ] Add `electron-updater` (optional, opt-in) with GitHub Releases as the feed; keep it disabled by default to preserve the lightweight/offline ethos.
- [ ] Add a reproducible `npm run build` doc and verify NSIS + portable artifacts launch on a clean Windows VM.
- [ ] Ensure model archives remain **never bundled** (download-on-demand) as documented in `AGENTS.md`.

**Verify:** `npm run pack` produces a working unpacked app; installer launches and transcribes end-to-end.

---

## Phase 9 — Dependency Management

- [ ] Audit and update dependencies (`@google/genai`, `sherpa-onnx-node`, `vosk-koffi`, `uiohook-napi`, `tar`, `unbzip2-stream`, `electron`, `electron-builder`) — one at a time, running `npm test` between updates.
- [ ] Run `npm audit` and resolve high/critical issues.
- [ ] Pin/keep native modules that are ABI-sensitive; document any that must not be bumped.

**Verify:** `npm audit` clean of high/critical; app runs after each bump.

---

## Phase 10 — Documentation & Contributor Experience

- [ ] Update `AGENTS.md` and `README.md` to reflect the new module layout, security model, theming system, and version.
- [ ] Expand `CONTRIBUTING.md` with the real `check`/`test`/CI workflow and coding conventions.
- [ ] Add short architecture diagram/notes for `main/` and `renderer/` modules.

**Verify:** a new contributor can build, test, and run following docs only.

---

## Phase 11 — Optional Feature Enhancements (stay within the core goal)

- [ ] Transcription history (last N, local-only, opt-in) with quick re-copy.
- [ ] More widget styles / a light theme (built on the Phase 6 theming system).
- [ ] Configurable output formatting (trim, capitalize, punctuation) toggles.
- [ ] Per-app or per-hotkey profiles.

*(Only implement after Phases 0–10; none may increase idle resource usage meaningfully.)*

---

## Definition of Done

- [ ] `npm run check` and `npm test` pass; CI green on Windows.
- [ ] Electron hardened: `contextIsolation: true`, `nodeIntegration: false`, `preload` + `contextBridge`, strict CSP.
- [ ] `main.js`, `renderer.js`, `index.html` split into focused modules; no single file is a monolith.
- [ ] Widget Style feature complete: 3 styles, persisted, live-synced, accessible, localized.
- [ ] No secrets logged; friendly, sanitized error handling everywhere.
- [ ] Repo clutter removed and git-ignored; version reconciled.
- [ ] Core goal intact: lightweight, always-on-top, offline-capable voice-to-clipboard Windows widget.

## Suggested Execution Order
`Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11`
Run `npm run check && npm test` after **every** phase and commit per phase with a clear message.
