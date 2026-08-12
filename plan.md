# VoiceToClipboard — Findings, Bugs & Improvement Plan (Production Hardening)

> **Status:** Regenerated from a full, file-by-file read of the codebase at **v4.0.0**, plus a live run
> of the project's own checks. This is a **findings + fix plan only — no application code was changed.**
>
> **Verified baseline (ran locally):**
> - `npm run check` → **Syntax OK: 21 JS files** (but the lint roots miss `preload.js`,
>   `bubble-preload.js`, `bubble-renderer.js`, `logger.js` — see M2).
> - `npm run check:i18n` → **parity OK: en/es/zh, 146 keys each.**
> - `npm test` → **31 tests pass, 0 fail.**
> So the *unit-tested* core (config/registry/audio/sanitizer/model-cache math) is solid. The bugs below
> live almost entirely in the **untested** surface: `renderer.js`, `main.js` runtime wiring, window
> lifecycle, and IPC — exactly the parts that decide whether the app actually works for a user.
>
> **Headline:** the app was hardened for Electron security (preload + `contextIsolation` +
> `nodeIntegration:false` + strict CSP), but **`renderer.js` was never migrated to match**. That single
> incomplete migration causes the two CRITICAL bugs — the renderer throws on its first line and never
> initializes, so the widget/settings UI does nothing. Fix those first; everything else is secondary.

---

## 1. What is actually implemented today (verified)

| Area | State |
|------|-------|
| Electron security | Hardened: `contextIsolation:true`, `nodeIntegration:false`, preload bridges, `will-navigate`/`window.open` locked down. |
| CSP | Strict in `index.html` (no `'unsafe-inline'`); `bubble.html` looser (`style-src 'unsafe-inline'`). |
| Widget Style themes | `crimson`/`ocean`/`aurora` fully wired + persisted + broadcast; ARIA radiogroup. |
| Reduced motion | **Implemented** — `@media (prefers-reduced-motion: reduce)` in `themes.css` neutralizes all animations. (Do not re-add as a task.) |
| STT Gemini | 5-model failover ladder + preferred-model memory + persisted 24h cooldowns (models & keys) + multi-key. |
| STT Local | 6 models, atomic download→verify→swap with backup/rollback + startup recovery, eco-mode unload, zip/tar/tar.bz2 + zip-slip guard. |
| Native shims | `koffi-asar-fix` (unpacked DLLs + PATH), `ort-preload` (absolute onnxruntime load vs System32 hijack). |
| i18n | en/es/zh + parity checker + live switching. |
| Logging/diag | Central sanitized `logger.js`, global crash handlers, redacted `copy-diagnostics`, renderer console → `app.log`. |
| Hygiene | Startup cleanup of stale caches, archives, crashpad dumps, oversized caches, old logs. |
| VAD/auto-stop | Adaptive noise floor, percentile auto-calibrate, live meter, dead-mic + digital-silence (RMS) guards, suspended-context resume. |

---

## 2. Bugs & issues (by severity, with detailed fixes)

### 🔴 CRITICAL

- **C1 — `renderer.js` calls `require()`, which does not exist in the renderer.**
  Top of file:
  ```js
  const LOCALES = { en: require('./locales/en.json'), es: require('./locales/es.json'), zh: require('./locales/zh.json') };
  ```
  With `nodeIntegration:false` + `contextIsolation:true` and no preload exposure of `require`/locales,
  `require` is **undefined in the renderer's main world** → `renderer.js` throws `require is not defined`
  on its first executed line → **the whole widget/settings script never runs** (mic dead, drag dead,
  settings dead). `bubble-renderer.js` is fine (uses only `window.bubbleApi`).
  **Detailed fix (recommended — option 1):**
  1. In `preload.js`, `const en = require('./locales/en.json')` (etc.) and add to the bridge:
     `locales: { en, es, zh }` (plain JSON objects are safe to expose).
  2. In `renderer.js`, replace the `require` block with `const LOCALES = window.api.locales;`.
  3. Confirm `locales/**` is in `package.json` `files` (it is) so the preload can require them when packaged.
  *(Alt: `fetch('locales/xx.json')` at startup — allowed by `connect-src 'self'`; verify under asar. Or an esbuild bundle that inlines the JSON.)*
  **Verify:** launch → no `require is not defined` in devtools/`app.log`; widget renders; mic reacts.

- **C2 — Every `window.api.on(...)` payload handler reads the wrong argument (systemic off-by-one).**
  `preload.js` intentionally strips the event: `const listener = (_event, ...args) => callback(...args);`
  so callbacks get **only the payload**. But `renderer.js` still uses the legacy `(event, payload)`
  signature, so `payload` is always `undefined` and the event slot is misread. Broken handlers:
  | Channel | Current (broken) | Symptom |
  |---|---|---|
  | `settings-changed` | `(event, snapshot)` | `snapshot` undefined → `snapshot.uiLanguage` **throws**; live settings→widget sync dead |
  | `widget-hover` | `(event, payload)` | `payload` undefined → `inside` always false → OS-cursor hover/pill-wake dead |
  | `gemini-fallback` | `(e, model)` | shows "switched to **undefined**" |
  | `download-progress` | `(event, data)` | `if (!data) return` bails → **progress bar never moves** |
  (`sync-settings`, `models-changed`, `toggle-recording`, `open-settings` take no args → fine.)
  **Detailed fix:** change those four renderer callbacks to take the payload as the **first** arg:
  `('settings-changed', (snapshot) => …)`, `('widget-hover', (payload) => …)`,
  `('gemini-fallback', (model) => …)`, `progressListener = (data) => …`.
  (Do **not** also change the preload, or you'll double-shift.)
  **Verify:** change a setting → widget recolors live, no console error; hover widget → pill appears;
  download a model → % advances; trigger a Gemini fallback → correct model name shown.

### 🟠 HIGH

- **H1 — CSP `style-src 'self'` blocks HTML-authored `style="…"` attributes in `index.html`.**
  External stylesheets (`base/widget/settings/themes.css`) are correctly `<link>`ed and load fine. But
  `index.html` has many **parser-inserted `style="…"` attributes**, including several
  `style="display:none;"` initial-hidden states. Chromium blocks parser-inserted inline styles under
  `'self'` (no `'unsafe-inline'`), so those don't apply → broken spacing and hidden panels render
  **visible** at load. *Nuance:* JS/CSSOM-set styles (`el.style.x=…`) are **not** blocked, so once the
  renderer runs it can still toggle — but with C1 the renderer never runs, so the page shows every panel
  expanded. **Fix (prefer 1):** (1) move the inline `style` attributes into `styles/*.css` via classes/ids;
  (2) stopgap: add `'unsafe-inline'` to `style-src` (weaker — avoid long-term).
  **Verify:** no `Refused to apply inline style` in devtools; hidden panels start hidden; layout correct.

- **H2 — Malformed `<input>` tag (paste-key field) in `index.html`.**
  `… style="…" type="text"/ data-i18n-placeholder="spacepaste.keyPlaceholder">` — the `"/` before the
  attribute is invalid self-closing syntax; the placeholder is likely dropped.
  **Fix:** `… type="text" data-i18n-placeholder="spacepaste.keyPlaceholder" />`.

- **H3 — "Transcribe Again" crashes when the engine changed Gemini→Local before retry.**
  `lastAudio.pcm` is only computed when the *original* recording ran under Local. In
  `retranscribeLast()`, if it was recorded under Gemini and the user then switches to Local and retries,
  `pcm: audio.pcm.buffer` dereferences `null` → `TypeError` (caught, surfaces as generic "ERROR").
  **Fix:** in `retranscribeLast`, when `cfg.sttEngine === 'local' && !audio.pcm`, derive PCM from
  `audio.blob` via `audioBlobTo16kHzFloat32(audio.blob)` before sending (and cache it back onto
  `lastAudio.pcm`); otherwise keep the existing path. **Verify:** record on Gemini → switch to Local →
  Transcribe Again succeeds.

- **H4 — Widget can restore off-screen and become unrecoverable (production reliability).**
  `createWindow()` uses saved `config.windowX/windowY` verbatim with **no bounds validation**. If the
  monitor that held the widget is disconnected, the layout changes, or resolution/DPI changes, the
  frameless + transparent + click-through widget renders **off every display** → the user sees nothing,
  and the tray click only `focus()`/`show()`s (it never repositions), so there's no recovery.
  **Detailed fix:**
  1. After computing desired `{x,y}`, validate against `screen.getAllDisplays()` work areas: the window
     rect must intersect at least one display's `workArea` by a minimum margin.
  2. If it doesn't (or `windowX/Y` are undefined/NaN), clamp/center onto
     `screen.getPrimaryDisplay().workArea`.
  3. Add a tray menu item **"Reset widget position"** that recenters on the primary display.
  4. Re-validate on `screen` `display-removed`/`display-metrics-changed` events and nudge the widget back
     into view.
  **Verify:** save a position on a second monitor, disconnect it, relaunch → widget appears on the
  primary display.

### 🟡 MEDIUM

- **M1 — `preload.removeListener` removes *all* listeners on a channel.**
  It calls `ipcRenderer.removeAllListeners(channel)` and ignores the specific `callback`. Two
  subscribers to one channel → removing one kills both. **Fix:** track `callback → wrappedListener` in a
  `Map` inside `on()` and have `removeListener` remove only the matching wrapper (or standardize on the
  unsubscribe closure that `on()` already returns and drop `removeListener`).

- **M2 — `check-js.js` doesn't lint 4 shipped files (confirmed: it reports only 21 files).**
  `roots` = `main.js, renderer.js, win32.js, stt, scripts, tests` → `preload.js`, `bubble-preload.js`,
  `bubble-renderer.js`, `logger.js` are **never syntax-checked**, though they ship. **Fix:** add those
  four to `roots` (or collect all root-level `*.js`). Also it's syntax-only — see L4 for real linting.

- **M3 — `lastErrorText` set only on *local* failures.**
  In `transcribe-audio`, the Gemini branch never sets `lastErrorText`, so `copy-diagnostics`
  under-reports Gemini errors. **Fix:** set `lastErrorText = ${code}: ${error}` (sanitized) on Gemini
  failure too.

- **M4 — Always-on timers / IPC chatter (contradicts the "≈0% idle" goal).**
  - `foregroundPoll` (500 ms, main) runs for the whole lifetime even when paste features are off.
  - `widgetHoverPoll` (200 ms, main) sends IPC **every tick while the cursor is inside the widget**
    (`inside !== last || inside`), not only on state change.
  - `setInterval(refreshRetranscribeBtn, 700)` (renderer) runs forever.
  **Fix:** gate `foregroundPoll` on "a paste feature is enabled"; only send hover IPC on state change
  plus a low-rate (e.g. 10 Hz) position update while inside; make the retranscribe-button refresh
  event-driven (call it where `lastAudio`/recording state changes). **Verify:** measure idle CPU/wakeups.

- **M5 — Gemini model whitelist ≠ failover ladder.**
  `validateSttConfig` allows only `{2.5-flash, 2.5-pro, 2.0-flash}`, but the ladder is
  `[2.5-pro, 2.5-flash, 2.5-flash-lite, 2.0-flash, 2.0-flash-lite]`. It happens not to wipe the
  auto-selected preferred model today (the explicit `geminiModel:` line in `save-stt-config` runs after
  the `...stt` spread and falls back to `existing.geminiModel`), but the disagreement is a latent trap.
  **Fix:** one shared constant for the model list; validate against the full ladder.

- **M6 — Possible sherpa stream leak per transcription.**
  `SherpaAdapter.transcribe` does `const stream = loaded.recognizer.createStream()` and never frees it
  (vosk correctly frees its recognizer in `finally`). Over many transcriptions this can leak native
  memory. **Fix:** `try { … } finally { stream.free?.() / stream.delete?.() }` for whatever the
  sherpa-onnx build exposes. **Verify:** RAM stable across many back-to-back local transcriptions.

- **M7 — `downloadFile`: unbounded redirects, first-hop-only timeout, partial-file on error.**
  On 3xx it recurses on `Location` with **no hop counter** (redirect loop → unbounded recursion);
  `request.setTimeout(120000)` is attached only to the first request, not redirect targets; on
  mid-stream `response`/`output` error the write stream isn't explicitly destroyed. (The `_install`
  catch removes the whole temp dir, so leftover files are mostly handled.) **Fix:** cap redirects (≤5),
  set the timeout on every hop, and destroy/close the write stream on error.

- **M8 — 32 MB IPC cap rejects local recordings well before the advertised 15-minute limit.**
  `transcribe-audio` rejects payloads `> 33,554,432` bytes with `AUDIO_TOO_LARGE`. Local PCM is Float32
  (4 bytes/sample @ 16 kHz), so 32 MB ≈ **8.7 minutes**, but `audio.js` advertises
  `MAX_AUDIO_SECONDS = 15 min`. A 9–15 min dictation fails with a scary error even though the pipeline
  claims to support it. **Fix:** raise the local-PCM cap to match 15 min of Float32 (~57.6 MB) — or use a
  duration-based check with a friendly message — while keeping a sane absolute ceiling and a separate
  (smaller) cap for the compressed Gemini path. **Verify:** a ~12-min local recording transcribes.

- **M9 — Second instance runs global side-effects before quitting.**
  Module top-level executes `uIOhook.start()`, `new SttService(...)`, IPC registration, and the startup
  diagnostic log **unconditionally**, even when `requestSingleInstanceLock()` returned false and
  `app.quit()` was called. The dying second instance briefly installs a **global keyboard/mouse hook**
  and writes to the shared `app.log`, which can conflict with the primary instance. **Fix:** move all
  initialization/side-effects (uIOhook start, SttService construction, timers, `whenReady` chain) into
  the `gotTheLock === true` branch, or early-`return` when the lock isn't held. **Verify:** launch a
  second copy → it exits immediately with no hook registration and no duplicate hotkey firing.

- **M10 — `saveConfig` does synchronous disk I/O on the main thread, called very frequently.**
  Every debounced window move, every settings autosave, and each Gemini cooldown update calls
  `saveConfig`, which runs `readFileSync + writeFileSync + renameSync` on the UI/main thread. The
  merge-with-fresh-`loadConfig()` protects *different* keys from clobbering, but (a) sync FS on the main
  thread can stall the app if the disk is busy or an AV scans the file mid-write, and (b) rapid saves
  re-parse+re-serialize the whole file each time. **Fix:** keep an in-memory config object as the source
  of truth; write via `fs.promises` through a single-writer queue (so temp/rename never overlap);
  debounce/coalesce bursts (e.g. 250 ms). **Verify:** no UI hitch during rapid slider drags / window drags.

### 🟢 LOW / polish

- **L1 — Dead no-op block** at the top of `uIOhook.on('keydown', …)` (empty `if (…isFocused())` with
  only comments). Remove.
- **L2 — Repo clutter:** delete + git-ignore `pack-validation.log` (root) and the empty
  `extract-7522/`, `extract-plain-tar/` (and any `dist_build*`).
- **L3 — `--expose-gc` reliance:** confirm by measurement that Power-Saving Mode actually reclaims model
  RAM promptly; don't assume.
- **L4 — No CI + no real linter.** Add GitHub Actions (`npm ci && npm run check && npm run check:i18n &&
  npm test` on a Windows runner) and consider ESLint for real static analysis (would have caught C1/C2's
  `require`/undefined usage and the H2 malformed tag).
- **L5 — Dead `moonshine` branch** in `sherpa-adapter.js` (no registry model uses it; `parakeet` ≈
  `nemo-transducer`). Trim/deduplicate.
- **L6 — `console-message` handler shape:** `main.js` reads `event.level/message/sourceId/lineNumber`
  (newer event-object API). Confirm it matches Electron 43 so renderer errors reach `app.log` — this is
  the primary signal for verifying C1/C2 fixes.
- **L7 — Hardcoded English strings** still in `renderer.js` (e.g. `'Ready to use locally'`,
  `'🗑 Remove'`, `'⚠️ Pending'`, `'✓ Installed'`, `'Threshold reset to the default (12)'`, the
  `gapWarn()` messages, `'Settings mic preview unavailable'`) and a few in `index.html`
  ("Silence Sensitivity Threshold"). `check:i18n` can't catch these because they never reach the JSON.
  **Fix:** move them into locale files.
- **L8 — Vacuous test assertion.** `tests/stt.test.js` → `redacts API keys…` asserts
  `message.includes('top-secret') === false`, but `'top-secret'` never appears in the input (always
  true). The real assertion (googleKey removed) is fine; tighten or remove the vacuous line.

---

## 3. Suggested fix order
1. **C1** (renderer boots) → **C2** (IPC payloads) — nothing works until these land.
2. **H1, H2** (rendering) → **H4** (off-screen recovery) → **H3** (retry crash).
3. **M1–M10** — teardown, lint coverage, diagnostics, timers, model-list unification, sherpa stream,
   download robustness, size cap, single-instance guard, async config writes.
4. **L1–L8** — cleanup, CI/lint, dead code, i18n gaps, test tidy-up.

## 4. Verification after fixes
```bash
npm run check      # extend roots (M2) — expect >21 files
npm run check:i18n # parity stays green
npm test           # 31+ green
npm start          # watch %APPDATA%\VoiceToClipboard\app.log for renderer errors
```
Manual smoke checklist:
- Boots with **zero** `require is not defined` / CSP / TypeError messages.
- Record→transcribe→paste on **both** Gemini and Local; a ~12-min local recording works (M8).
- Change a setting → floating widget updates live (opacity, style, language) (C2).
- Hover the click-through widget → settings pill appears (C2/M4).
- Download a local model → progress bar advances (C2).
- Transcribe Again works, including after switching engine (H3).
- Move widget to a 2nd monitor, disconnect it, relaunch → widget still visible (H4).
- Launch a 2nd copy → it exits cleanly, hotkey fires once (M9).

**Definition of done:** renderer boots clean; all 4 push channels deliver payloads; UI renders (hidden
panels hidden); record→transcribe→paste works both engines incl. long local audio; widget is always
recoverable on-screen; single-instance is side-effect-free; config writes never stall the UI;
`check`/`check:i18n`/`test` pass; CI green on Windows; clutter removed.

---

## 5. Optional enhancements (only after the above; stay lightweight, offline-first)
- Transcription history (last N, local-only, opt-in) with quick re-copy.
- More widget styles / a light theme (theming system already supports it).
- Output formatting toggles (trim / capitalize / punctuation).
- Per-app or per-hotkey profiles.
- **A headless Electron smoke test** that loads the widget window and fails on any console error — this
  single test would have caught both CRITICAL bugs automatically.
