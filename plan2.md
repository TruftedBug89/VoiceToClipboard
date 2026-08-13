# plan2.md — RAM reduction, smooth/on-time AI unloading, and a small portable widget

> Goal (from the ask): thoroughly scan how the app works, then **without breaking anything**:
> 1. reduce RAM usage,
> 2. make AI (STT model) unloading **smooth and on time**, and
> 3. make the app a **small, portable widget**.
>
> This plan is intentionally incremental and reversible. Every item lists the file(s) it
> touches, the expected win, the risk, and how to verify. Nothing here changes the security
> model (contextIsolation, CSP, whitelisted `window.api`) or the transcription accuracy.

---

## 0. How the app works today (scan summary)

**Process shape (Electron 43, Windows):**
- **Main process** (`main.js`, `logger.js`, `win32.js`) owns: windows, tray, global hotkeys,
  config, clipboard, paste bubble/toast, and the **STT layer** (`stt/*`). Native STT addons
  (`sherpa-onnx-node`, `vosk-koffi` via `koffi`) run **in the main process**.
- **Renderer** (`index.html` + `renderer.js`, sandboxed, CSP): mic capture (Web Audio /
  `MediaRecorder`), VAD, meter, visualizer, and the settings UI. Talks to main only through
  `preload.js` → `window.api`.
- **Extra windows:** the paste **bubble** (`bubble.*`) is created on demand; the **settings**
  window is a second `BrowserWindow` created on demand.

**Model lifecycle (the core of the RAM story):**
- Models are **downloaded at runtime** into `%APPDATA%\VoiceToClipboard\models` (240 MB–1.6 GB
  on disk; ~250 MB–1.1 GB peak RAM). They are **not** bundled in the installer. 👍
- `SherpaAdapter`/`VoskAdapter` keep **one** model resident in `this.loaded`.
- **Eco Mode (default ON)**: after every transcription, `transcribeLocal()` calls
  `adapter.unload()` → native `free()`/`delete()` + a `--expose-gc` forced GC on `setImmediate`.
  So RAM returns to baseline between dictations, but the model is **reloaded from disk every
  time** (slower first word).
- **Eco Mode OFF ("keep loaded")**: the model **never** unloads on its own. It only unloads on
  engine switch, model removal, or app exit → RAM stays high (up to ~1.1 GB) indefinitely.
- **On quit**, models are deliberately **not** unloaded (native teardown racing Electron caused
  `0xc0000409` crashes); the OS reclaims the memory.

**Startup cost:** `main.js` constructs `new SttService(...)` at module load, and `stt/index.js`
eagerly `require`s `ort-preload`, `koffi-asar-fix`, `sherpa-adapter` (→ `sherpa-onnx-node`) and
`vosk-adapter` (→ `vosk-koffi`) **at the top of the file**. So the ONNX Runtime + koffi native
libraries load into the main process **at launch, even for Gemini-only users and even before the
first local transcription**.

**Always-on background work:**
- `app.disableHardwareAcceleration()` (good for a tiny widget).
- Two `setInterval`s in main: `foregroundPoll` (500 ms, but early-returns unless `spacePaste`)
  and `widgetHoverPoll` (200 ms, always runs while the widget is visible).
- `webPreferences.backgroundThrottling: false` on the widget **and** settings windows.
- Renderer runs a visualizer/idle-ring animation loop (already paused when hidden).

**Portability today:** `package.json` build already emits an NSIS installer **and** a `portable`
target. `asarUnpack` ships the native dirs (`sherpa-onnx-win-x64`, `koffi`, `vosk-koffi`,
`uiohook-napi`). The heavy model weights are downloaded on demand, so the shipped artifact is
"only" the Electron runtime + native ORT/vosk binaries.

---

## 1. Smooth & on-time AI unloading (highest-value change)

**Problem:** the current design is binary. Eco ON = unload after *every* clip (RAM-friendly but
slow reload). Eco OFF = *never* unload (fast but permanently holds ~0.3–1.1 GB). There is no
"unload after the user is done for a bit" middle ground, and the immediate synchronous
`free()` + forced GC right after a transcription can add a small hitch to the "copied" moment.

### 1.1 Add an idle-unload timer (the "on time" part)
Introduce a single idle timer in the STT layer so the model unloads **after N seconds of
inactivity** instead of instantly or never.

- Where: `stt/index.js` (`SttService`) — add `scheduleIdleUnload()` / `cancelIdleUnload()`.
- Behavior:
  - On a successful local transcription, **cancel** any pending idle-unload, keep the model warm.
  - After the transcription completes, **(re)arm** an idle timer (default e.g. **20 s**).
  - When it fires, call `unloadAll()`.
  - Eco Mode ON = idle window `0` (unload immediately — preserves today's default behavior).
  - Eco Mode OFF = idle window `> 0` instead of "never" (this is the real RAM win for
    keep-loaded users while staying fast for back-to-back dictation).
- Config: add `idleUnloadSeconds` (validated/clamped in `stt/config.js`, e.g. 0–300, default 20).
  Keep `ecoMode` working exactly as before by mapping `ecoMode===true → idle 0`.

**Win:** back-to-back dictations stay instant; RAM returns to baseline shortly after the user
stops. **Risk:** low — it only changes *when* the existing `unload()` runs. **Verify:** dictate
twice quickly (no reload between), wait past the idle window, confirm RAM drops in Task Manager.

### 1.2 Make the unload itself non-janky (the "smooth" part)
- Move the post-transcription unload **off the hot path**: return the transcript to the user
  first, then run `freeNativeMemory()` + GC on the next `setImmediate`/idle tick (the adapters
  already use `setImmediate` for GC — extend the same idea to the whole unload when triggered by
  the idle timer, so freeing never blocks a user-visible action).
- Debounce/guard reloads: if a new request arrives while an idle-unload is pending, cancel the
  unload rather than unload-then-reload.
- Coalesce GC: avoid scheduling multiple `global.gc()` calls in quick succession (one trailing
  GC after the native free is enough).

**Win:** no hitch on the "copied ✓" moment; no wasteful unload→reload thrash. **Risk:** low.

### 1.3 Unload when switching away / hiding for a long time
- On engine switch to Gemini (already done) and when the widget stays hidden for a while,
  arm the same idle-unload so a backgrounded app doesn't sit on model RAM.

---

## 2. Reduce RAM usage

### 2.1 Lazy-load the native STT stack (biggest startup RAM win)
Today `require('./stt')` → ORT + koffi + vosk load at launch for **everyone**.
- Change `stt/index.js` so `SherpaAdapter`/`VoskAdapter` and their `require`s
  (`sherpa-onnx-node`, `vosk-koffi`, `ort-preload`, `koffi-asar-fix`) are pulled in **lazily** on
  first *local* use (e.g. inside `transcribeLocal()` / adapter `load()`), not at module top.
- Gemini-only users and idle-at-launch users then never map the ONNX Runtime into memory.
- Keep `ort-preload` ordering guarantee: still run it **before** the first
  `require('sherpa-onnx-node')`, just do both lazily together.

**Win:** meaningfully lower idle/startup RAM for cloud users and faster cold start. **Risk:**
medium — must preserve the ORT-preload-before-sherpa ordering (see `stt/ort-preload.js` comment)
and the koffi-asar fix. **Verify:** launch with engine=Gemini, confirm ORT DLL is not loaded
(app.log / no sherpa memory), then switch to local and confirm it still transcribes.

### 2.2 Destroy the settings window on close (free a whole renderer)
- `createSettingsWindow()` creates a 400×700 `BrowserWindow`. Confirm it is **destroyed** (not
  just hidden) on close so its Chromium renderer process is released. If it's currently hidden,
  switch to destroy-on-close and recreate on demand.

**Win:** frees a full renderer process (tens of MB) whenever settings isn't open. **Risk:** low.

### 2.3 Let hidden windows throttle
- `backgroundThrottling: false` is set on both windows. It's justified for the **widget** (it
  must react to hotkeys/hover), but the **settings** window has no reason to run un-throttled.
  Set `backgroundThrottling: true` for settings.
- Optionally, only the widget truly needs it; re-evaluate whether the widget needs it when
  fully hidden vs. just idle.

**Win:** lower background CPU (and the RAM that churning keeps alive). **Risk:** low.

### 2.4 Tune ONNX Runtime session options for lower footprint
In `stt/sherpa-adapter.js` the configs set `numThreads`/`provider` but not memory options.
- Investigate exposing (where `sherpa-onnx-node` supports it) `enableMemoryPattern: false` and
  arena/allocator options for the big Whisper/Parakeet models, which trade a little speed for a
  smaller resident set. Gate this behind the model size (reuse the `big|large|whisper` test from
  `stt/threading.js`).
- `maxModelSec: 30` chunking for Whisper is already good — keep it.

**Win:** trims peak RAM on the largest tiers. **Risk:** medium (depends on binding support) —
prototype and measure before shipping; leave defaults if no gain.

### 2.5 Cap V8 heap in the main process
- Add a conservative `--max-old-space-size` (e.g. 128–256 MB) via
  `app.commandLine.appendSwitch('js-flags', ...)` alongside the existing `--expose-gc`. The main
  process holds only PCM buffers + config, so a smaller old-space cap keeps JS heap growth in
  check without affecting native model RAM.

**Win:** modest, steadier main-process heap. **Risk:** low (keep the cap comfortable).

### 2.6 Free audio buffers promptly
- Confirm the in-memory "Transcribe Again" audio is the only retained copy and is cleared on
  success/cancel (AGENTS.md says it is). Double-check large `Float32Array`/`arrayBuffer` payloads
  from `transcribe-audio` aren't captured by closures (e.g. history/recording paths) longer than
  needed.

**Win:** avoids transient RAM spikes stacking up. **Risk:** low.

### 2.7 Reconsider the default tier vs. RAM
- `recommendedTierForRam()` defaults ≤16 GB → `light` (Omnilingual, ~550 MB). That's reasonable,
  but document that `tiny`/`mini` (≈250–270 MB) exist for users who prioritize RAM over accuracy,
  and surface the recommendation prominently in Settings.

**Win:** users on tight RAM can opt into a much smaller footprint. **Risk:** none (already exists;
this is UX/labeling).

---

## 3. Small, portable widget

### 3.1 Keep weights out of the bundle (already true — protect it)
- Models download at runtime; **never** bundle them. Add a build check/CI guard that the
  `dist/` artifact stays within an expected size ceiling so a stray model can't bloat it.

### 3.2 Trim what ships in the asar
- Audit `build.files` and `asarUnpack`. Ensure only the needed native binaries ship:
  - `sherpa-onnx-win-x64`, `koffi`, `vosk-koffi`, `uiohook-napi` are required.
  - Confirm no dev-only files, source maps, or duplicate ORT providers are packaged.
- Consider `electron-builder` `compression: maximum` for the portable target.

### 3.3 Portable-mode data location (true portability)
- Right now userData is forced to `%APPDATA%\VoiceToClipboard`. For a *portable* exe, optionally
  detect portable mode (e.g. env `PORTABLE_EXECUTABLE_DIR` that electron-builder's portable
  target sets) and place `config.json` + `models` **next to the exe** so the app carries its
  settings/models on a USB stick. Fall back to `%APPDATA%` when not portable.
- Keep the existing legacy-migration path intact.

**Win:** genuinely portable (settings + downloaded models travel with the exe). **Risk:** medium
— must not break the canonical-path migration for installed users; gate strictly on portable
mode. **Verify:** run the portable exe from a fresh folder, confirm config/models land beside it.

### 3.4 Optional: a "cloud-only lite" build flavor
- Because §2.1 makes native STT lazy, a build that omits the sherpa/vosk native deps entirely
  (Gemini-only) would be dramatically smaller. Offer it as a separate optional artifact for users
  who only use the cloud engine. (Do **not** replace the full build.)

---

## 4. Suggested order of work (safe → bolder)

1. **§1.1 + §1.2** idle-unload timer + smooth unload (biggest UX+RAM win, low risk).
2. **§2.2 + §2.3** destroy settings window on close, throttle it.
3. **§2.1** lazy-load native STT stack (test ORT ordering carefully).
4. **§2.5 + §2.6** heap cap + buffer hygiene.
5. **§3.1 + §3.2** protect/trim the bundle.
6. **§2.4** ORT session memory options (measure first).
7. **§3.3** portable data location; **§3.4** optional lite build.

---

## 5. Guardrails ("without breaking anything")

- **Do not** unload native models on `will-quit` (keeps the `0xc0000409` fix).
- **Preserve** ORT-preload-before-`sherpa-onnx-node` ordering when moving to lazy loading.
- **Keep** the security model unchanged: `contextIsolation`, `nodeIntegration:false`, CSP,
  whitelisted `window.api`, log redaction via `logger.js`/`error-sanitizer.js`.
- **Back-compat config:** map `ecoMode` semantics onto the new `idleUnloadSeconds` so existing
  `config.json` files behave exactly as before until the user opts in.
- **Verify each step** with: `npm test`, `npm run check`, a manual dictation cycle, and RAM
  observation in Task Manager (idle, mid-transcription, and 30 s after).

---

## 6. Measurement plan

Record before/after for each change:
- Main-process RAM at: launch (Gemini engine), launch (local engine), during transcription,
  and 30 s after the last transcription.
- Renderer RAM with settings open vs. closed.
- Cold-start time to first transcription.
- `dist/` artifact size (installer + portable).

Track these in a small table in the PR so regressions are obvious.
