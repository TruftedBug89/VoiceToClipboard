# VoiceToClipboard — Feature Plan (v4.x)

> **Scope:** three new features, specced in detail and designed to feel native to the current app.
> The earlier "Widget Style transformation" work is **already implemented** (styles now include
> `crimson`/`ocean`/`aurora`/`terminal` in `WIDGET_STYLES`) and has been removed from this plan.
>
> **The three features (chosen):**
> 1. **Transcription History** — a local-only, searchable list of recent transcripts with one-tap re-copy.
> 5. **Type-at-Cursor Output** — inject the transcript straight into the focused app, no manual paste.
> 8. **Microphone Input-Device Picker** — choose which mic to record from (with a live level test).

---

## 0. Design language — keep it pristine, modern, and consistent

Everything below must look and behave like it shipped with the app. Non-negotiables:

- **Visual system:** reuse the existing dark **glass** aesthetic — `--bg-glass`, `--border-glass`,
  `--text-main`, `--text-dim`, `--primary`/`--primary-hover`, 12–16px radii, `backdrop-filter: blur`,
  soft shadows (`0 6px 18px rgba(0,0,0,.45)`). **Never hardcode colors** — consume the theme tokens so
  all four Widget Styles (crimson/ocean/aurora/terminal) recolor the new UI automatically.
- **Settings layout:** each feature is a titled section in the Settings window, matching the current
  `Recording` / `Speech Engine` / `Appearance` / `Voice Recordings` sections — same section header,
  `.switch-label` rows, toggle switches, `select` styling, and muted `note` helper text.
- **Motion:** short, springy transitions consistent with the widget (`cubic-bezier(0.34,1.56,0.64,1)`
  for pops, `0.2–0.35s` ease for fades). **Respect `prefers-reduced-motion`** — the global reduce block
  in `themes.css` already neutralizes animations; don't add motion that bypasses it.
- **Security model (must not regress):** renderer stays `contextIsolation:true`, `nodeIntegration:false`.
  Every new main↔renderer call goes through the **`preload.js` allowlist** (`window.api`); no `require`
  or `ipcRenderer` in the renderer. Honor the strict CSP (no inline styles/scripts in `index.html`).
- **i18n:** all new user-facing strings become keys in `locales/en.json`, `es.json`, `zh.json` and must
  keep **parity** (`npm run check:i18n`). No hardcoded English in `renderer.js`/`index.html`.
- **Privacy-first:** transcripts and recordings never leave the machine; history and audio are **opt-in**
  and clearly labeled, matching the existing "Save Audio Recordings (Disabled by default)" pattern.

---

## 1. Shared foundation (do first — all three features depend on it)

### 1.1 Config schema (`stt/config.js`)
Bump `CONFIG_VERSION` **5 → 6** and extend `migrateConfig` + `validateSttConfig` with new, defaulted keys:

| Key | Type | Default | Feature |
|-----|------|---------|---------|
| `historyEnabled` | boolean | `false` (opt-in) | History |
| `historyLimit` | number | `50` (clamp 10–500) | History |
| `outputMode` | `'clipboard' \| 'bubble' \| 'toast' \| 'autotype'` | migrate from current `pasteStyle` | Type-at-cursor |
| `autotypeMethod` | `'unicode' \| 'paste'` | `'unicode'` | Type-at-cursor |
| `micDeviceId` | string | `''` (= system default) | Mic picker |
| `micDeviceLabel` | string | `''` (display only) | Mic picker |

- **Migration:** map the old `pasteStyle` (`bubble`/`toast`) into the new `outputMode`; if space-to-paste
  was disabled, `outputMode = 'clipboard'`. Keep `pasteStyle`/`pasteKey` working (bubble/toast still use them).
- Validate/clamp every field in `validateSttConfig` exactly like the existing entries (unknown → default).

### 1.2 Settings snapshot + persistence (`main.js`)
- Add the new keys to `getSettingsSnapshot()` so both windows receive them, and to the `save-stt-config`
  merge (mirror the existing `pasteStyle`/`saveRecordings` merge style: use incoming value if defined,
  else fall back to `existing`).
- Add them to the redacted diagnostic log line (values only, never transcript text).

### 1.3 Preload bridge (`preload.js`)
Extend the `window.api` allowlist with the minimum surface (details per feature):
`history.list/clear/delete/export`, `audio.listInputDevices` (or use `navigator.mediaDevices` directly in
the renderer — see 4.2), and reuse the existing push channels (`settings-changed`) for live updates.

---

## 2. Feature #1 — Transcription History

**Goal:** never lose a transcript again. Keep the last *N* transcripts locally; let the user search, re-copy,
re-paste, and clear them. Complements (does not depend on) the existing audio-recording save feature.

### 2.1 Storage (main process)
- Store at `userData/history.json` (sibling of the `recordings/` dir) as a bounded array, newest first:
  ```json
  { "version": 1, "items": [
    { "id": "uuid", "text": "…", "ts": 1699999999999, "engine": "local|gemini",
      "model": "omni-multilingual|gemini-2.5-flash", "lang": "auto", "chars": 42,
      "durationMs": 5300, "recordingFile": "recording_2026-…​.wav|null" }
  ]}
  ```
- **Append on success** inside the `transcribe-audio` success path (right where clipboard write happens),
  **only when `historyEnabled`**. Trim to `historyLimit`. If `saveRecordings` is on, link `recordingFile`.
- **Single-writer, async** writes (`fs.promises` + temp-file rename) to avoid clobbering — reuse the
  atomic-write approach already used for config.
- **Retention:** on `historyEnabled → false`, keep the file but stop appending; a **Clear history** button
  deletes it. Deleting a linked recording is optional and off by default.

### 2.2 IPC + preload
Add handlers: `history-list` (return items, optional `{query, limit}`), `history-delete(id)`,
`history-clear()`, `history-export()` (write `history.txt`/`.json` via a save dialog or into `recordings/`).
Expose through `preload.js` as `window.api.history.{list,delete,clear,export}` (payload-first callbacks).

### 2.3 UI / UX (Settings → new "History" section)
- **Section header** "Transcription History" + muted note: *"Kept locally on this PC only. Opt-in."*
- **Toggle:** "Save transcription history (last {n})" — same switch component as other toggles.
- **List (glass cards):** each row = relative time (e.g. "2m ago"), a 1–2 line **truncated preview**
  (`text-overflow: ellipsis`), the engine/model as a small dim chip, and hover actions:
  **⧉ Copy**, **⤶ Paste** (routes through the chosen `outputMode`), **🗑 Delete**. Whole row click → copy,
  with a brief "✓ Copied" flash reusing the widget's success color/animation.
- **Search field** at top: instant client-side filter over `text` (debounced), highlight matches.
- **Footer:** item count + **Clear all** (with an inline confirm, not a blocking dialog) + **Export**.
- **Empty state:** friendly centered note ("No transcripts yet — record something!") matching `--text-dim`.
- **Live update:** when a new transcript is copied, push `settings-changed` (or a dedicated
  `history-updated`) so an open Settings window prepends the new card with a subtle slide-in.

### 2.4 i18n keys (en/es/zh)
`history.title`, `history.note`, `history.toggleLabel`, `history.search`, `history.copy`, `history.paste`,
`history.delete`, `history.clear`, `history.clearConfirm`, `history.export`, `history.empty`, `history.copied`,
`history.count` (`"{n} items"`), `history.time.justNow/minAgo/hAgo/…`.

### 2.5 Edge cases
- Never store empty/whitespace-only transcripts. Cap a single stored item's length (e.g. 20k chars).
- Corrupt/oversized `history.json` → quarantine + start fresh (log sanitized). Concurrent writes serialized.
- History text is **redaction-safe in logs** — never log transcript contents (only counts).

### 2.6 Verify
Enable → dictate 3 times → 3 cards appear newest-first; search filters; copy/paste/delete work; Clear empties;
disable → no new cards, existing file preserved until Clear; relaunch → list persists; parity check passes.

---

## 3. Feature #5 — Type-at-Cursor Output

**Goal:** the transcript lands directly in the focused field — no bubble, no manual Space. This turns the
existing paste machinery into a first-class **Output mode**, so users pick how results are delivered.

### 3.1 Output mode model
Replace the current binary `pasteStyle` UX with one **"Output" selector** (`outputMode`, see 1.1):
- **Clipboard only** — copy, do nothing else (current default behavior without space-to-paste).
- **Paste bubble** — existing bubble (press paste key). *(keeps `pasteKey`)*
- **Windows notification** — existing toast.
- **Type at cursor (new)** — inject the text into the previously-focused window automatically.

### 3.2 Injection engine (`win32.js` + `main.js`)
Extend `win32.js` (koffi/user32 — already loaded) with real keystroke injection. Two methods behind
`autotypeMethod`:
- **`unicode` (default, recommended):** send the transcript as Unicode keystrokes via **`SendInput`** with
  `INPUT_KEYBOARD` + `KEYEVENTF_UNICODE` (down/up per UTF-16 code unit; handle surrogate pairs and `\n` →
  VK_RETURN). **Preserves the user's clipboard** and works in fields that block Ctrl+V.
- **`paste` (fallback):** the existing `clipboard.writeText` + `SetForegroundWindow(lastExternalHwnd)` +
  `sendCtrlV()` path. Use when Unicode injection is unavailable or the target chokes on synthetic keys.

Flow in the `transcribe-audio` success handler (main):
1. Capture the foreground window **before** our widget takes focus (reuse `lastExternalHwnd` tracking used
   by the paste bubble).
2. On success with `outputMode === 'autotype'`: `SetForegroundWindow(target)` → small settle delay
   (~40–80ms, tunable) → inject via the chosen method. Always also write the clipboard as a safety net
   (unless `autotypeMethod==='unicode'` and we want to preserve clipboard — then copy only if injection fails).
3. On any failure (no `win32`, `IsWindow(target)` false, injection error) → **fall back to the paste bubble**
   so the user is never stuck, and surface a one-line status.

### 3.3 UX / design
- In the **Space-to-Paste / Output** section, replace the two-option style control with the 4-way selector
  (reuse the existing `select` styling). Show **Paste key** only when mode = bubble; show **Injection method**
  (Unicode / Paste) only when mode = autotype (progressive disclosure, matching how paste-key already hides).
- Add a muted note under autotype: *"Types the transcript into the last active window. Preserves your
  clipboard. If an app blocks it, switch to 'Paste' method."*
- Keep the widget's existing "✓ COPIED" status; add a `status.TYPED` ("✓ TYPED") state so feedback is honest
  about what happened.

### 3.4 i18n keys
`output.label`, `output.mode.clipboard`, `output.mode.bubble`, `output.mode.toast`, `output.mode.autotype`,
`output.method.label`, `output.method.unicode`, `output.method.paste`, `output.autotypeNote`, `status.TYPED`.

### 3.5 Edge cases / safety
- Target window closed/changed between record and finish → `IsWindow` guard → bubble fallback.
- Elevated/admin target windows may reject synthetic input (UIPC) → detect failure → bubble fallback + note.
- Very long transcripts: chunk Unicode injection and yield to avoid flooding the input queue.
- Password fields / sensitive targets: we can't detect these reliably — the muted note warns the user;
  default remains non-autotype so nothing types unexpectedly.
- Newlines/tabs mapped to real VK keys; emoji/CJK verified via surrogate-pair handling.

### 3.6 Verify
Set mode = Type at cursor → focus Notepad/VS Code/browser field → dictate → text appears at the caret,
clipboard unchanged (unicode method); close target mid-flow → falls back to bubble; toggle to Paste method →
still works; reduced-motion unaffected; parity check passes.

---

## 4. Feature #8 — Microphone Input-Device Picker

**Goal:** let users record from a specific mic (headset, interface, webcam) instead of only the OS default,
with a quick live-level test so they can confirm the right device before dictating.

### 4.1 Config + persistence
- Persist `micDeviceId` (+ `micDeviceLabel` for display). Empty = follow system default.
- On save, broadcast `settings-changed` so the widget's next recording uses the new device immediately.

### 4.2 Renderer capture changes (`renderer.js`)
- Replace the three `getUserMedia({ audio: true })` call sites with a shared helper
  `getMicStream()` that builds constraints from config:
  ```js
  const id = currentMicDeviceId;
  const audio = id ? { deviceId: { exact: id } } : true;
  return navigator.mediaDevices.getUserMedia({ audio });
  ```
- **Robust fallback:** if `{exact:id}` throws `OverconstrainedError`/`NotFoundError` (device unplugged),
  retry with `{ audio: true }`, show a one-line notice, and mark the saved device as "unavailable" in
  Settings (don't silently pick a random mic without telling the user).
- Enumerate devices with `navigator.mediaDevices.enumerateDevices()` filtered to `kind === 'audioinput'`.
  Labels are only populated **after** mic permission is granted once — call `getUserMedia` first (the app
  already does for the level meter), then enumerate, so real names show.
- Listen to `navigator.mediaDevices.ondevicechange` to refresh the dropdown when devices are plugged/unplugged.

### 4.3 UX / design (Settings → "Recording" section, near Auto-Stop)
- **Label:** "Microphone" + a native-styled `select` listing "System default (recommended)" first, then each
  input device by label. Persist selection on change (autosave, like other settings).
- **Live level meter:** reuse the **existing Auto-Stop live mic meter** component so it looks identical —
  a slim bar that fills with `calculateSpeechVolume`, using the selected device, so users see it react while
  choosing. A tiny **"Test"** affordance starts/stops a short preview stream on the chosen device.
- **Unavailable state:** if the saved device is gone, show it greyed with "(not connected)" and auto-fall
  back to default until it returns.

### 4.4 i18n keys
`mic.label`, `mic.systemDefault`, `mic.test`, `mic.testing`, `mic.unavailable`, `mic.permissionNeeded`,
`mic.changed` (`"Using {name}"`).

### 4.5 Edge cases
- No mic permission yet → device labels are blank; show "System default" + a "grant permission" hint,
  populate real names after first capture.
- Device removed mid-recording → the active MediaRecorder stream ends; surface `MIC_UNAVAILABLE` (existing
  status) and fall back to default for the next recording.
- Multiple identical device labels → append a short id suffix to disambiguate.

### 4.6 Verify
Plug in a second mic → it appears in the dropdown with its real name; select it → the live meter reacts to
that mic; dictate → recording uses it; unplug it → dropdown updates, next recording falls back to default
with a notice; selection persists across relaunch; parity check passes.

---

## 5. Cross-cutting verification (run after each feature)
```bash
npm run check       # syntax OK
npm run check:i18n  # en/es/zh parity (add keys to all three)
npm test            # unit tests stay green (add config-migration tests for v6)
npm start           # watch %APPDATA%\VoiceToClipboard\app.log for CSP / require / TypeError
```
Manual smoke: all four Widget Styles recolor the new UI; reduced-motion calms new animations; no inline-style
CSP violations; renderer uses only `window.api` (no `require`); transcripts/recordings never logged.

## 6. Suggested build order
1. **Shared foundation** (§1): config v6 migration + snapshot + preload allowlist + migration unit tests.
2. **Feature #8 Mic picker** — smallest, mostly renderer + one config field; validates the settings pattern.
3. **Feature #5 Type-at-cursor** — extends `win32.js`; reuses `lastExternalHwnd`; bubble fallback keeps it safe.
4. **Feature #1 Transcription history** — new storage + IPC + the richest UI; lands last so it can link to
   recordings and route "Paste" through the finished output-mode work from #5.
