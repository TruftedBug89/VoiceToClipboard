# VoiceToClipboard — Visual Redesign, Feedback & Bug-Fix Plan

_Scope: keep the visual identity the user already likes (glass widget, crimson orb, sonar rings, themes). Add much stronger feedback for **transcribing / success / failure**, and eliminate the "little design issues" so every state and every theme feels fully unified. Also fix bugs found during the audit._

---

## 1. App snapshot (what exists today)

- **Electron widget** (`index.html` + `renderer.js`, 2722 lines) — a click-through floating mic orb with a canvas visualizer, sonar/aura/spin rings, and a frameless Settings window.
- **Styling** is split into 4 files loaded in order: `styles/base.css` (mic + FX), `styles/widget.css` (status badge), `styles/settings.css` (modal + controls), `styles/themes.css` (4 widget styles: Crimson/Ocean/Aurora/Terminal via `:root[data-widget-style]`).
- **State machine (renderer):** idle → `starting` → `recording` → `transcribing` → `done`/`err` (or `cancelled`). Visuals are driven by classes on `#mic-button`, `#mic-container`, `#status-badge` and `body`.
- **Feedback surfaces today:**
  - `#status-badge` (dot + text) with modes `busy | done | dim | err`.
  - `#mic-button` FX classes: `recording`, `transcribing`, `pop`, `burst`, `show-check`.
  - Success chime (`playFinishChime`, E5→A5), gated by the "finish sound" setting.
  - `#retry-btn` ("Transcribe Again") on retryable failures.

---

## 2. Root problem: states & themes don't fully "merge into the style"

### 2.1 Semantic colors are hardcoded, not theme-aware
Literal color audit (should be design tokens instead):

| File | crimson literals | green literals | amber literals |
|---|---|---|---|
| base.css | 2 | 4 | 0 |
| widget.css | 0 | 2 | 0 |
| **settings.css** | **27** | 10 | 6 |
| themes.css | 3 | 0 | 0 |

Consequences:
- The **Settings modal is hardwired crimson** (`rgba(230,57,70,…)` ×27). When the widget style is Ocean (blue), Aurora (purple) or Terminal (green), the widget changes but the settings panel, focus glows, toggles, save button and scrollbar **stay red** — the biggest "doesn't merge" issue.
- **Error state == brand color.** `#status-badge.err` and `#retry-btn` reuse `--primary`. In non-Crimson themes an "error" shows up blue/purple/green, so failure reads as normal. Error has no dedicated semantic color.
- **Two different greens** for success: `#4ade80` (mic glow, done dot) vs `#10b981` (status pill "ready"). No single success token.

### 2.2 Fix: introduce a semantic token layer (in `base.css :root`, overridable per theme)
```
--success: #4ade80;  --success-soft: rgba(74,222,128,.15);
--danger:  #ff5468;  --danger-soft:  rgba(255,84,104,.16);
--warning: #f59e0b;  --warning-soft: rgba(245,158,11,.14);
--focus-glow: color-mix(in srgb, var(--primary) 35%, transparent);
```
Then **replace every hardcoded `rgba(230,57,70,…)` in settings.css with `--primary`/`color-mix(... var(--primary) …)`** and every hardcoded green/amber with `--success`/`--warning`. Keep `--danger` independent of `--primary` so failure is always visually distinct **even on the Crimson theme** (use a slightly hotter/pinker red + a shake, see §3.3).

---

## 3. Feedback redesign (the headline request)

Keep the existing look; make each phase unmistakable and on-theme.

### 3.1 TRANSCRIBING (make "working" obvious)
- Keep the fast spin-ring + `transcribing-pulse`.
- Add an **indeterminate progress arc / animated dots** to the status badge text (`TRANSCRIBING·`, `··`, `···`) so it never looks frozen on slow local models.
- Show a subtle **shimmer sweep** across the mic button while transcribing (theme-tinted via `--primary`).
- Badge dot already becomes a spinner in `busy` — good; ensure it uses `--primary` (already does) so it themes correctly.

### 3.2 SUCCESS (unify + strengthen)
- Keep check-morph + `burst` + `container-breath` + chime.
- Route the green through the new `--success` token everywhere (mic glow, done dot, `✓ COPIED/TYPED` text) so it's one consistent green.
- Add a brief **success ripple** reusing the `.burst-ring` but tinted `--success`, plus a 1-line ephemeral confirmation ("Copied to clipboard" / "Typed at cursor") fading after ~1.6 s (matches current `hideStatus` timing).

### 3.3 FAILURE (currently the weakest — biggest win)
Today failure only recolors the badge (and to brand red). Add:
- **`#mic-button.error` state:** morph the mic icon to an **✕ / error glyph**, glow with `--danger`, and a **short shake** (`@keyframes error-shake`). Symmetric to the success `show-check`.
- **`#status-badge.err`** uses `--danger`/`--danger-soft` (not `--primary`), so failure is always red regardless of theme.
- **Distinct error tone** (single low tone) — reuse the WebAudio chime helper; gate by the same finish-sound setting.
- **Clear, human status text per code** (extend the existing map): `NO_SPEECH → "No speech heard"`, `MIC_TOO_QUIET → "Mic too quiet"`, `NO_API_KEY → "Add a Gemini key"`, `MODEL_UNAVAILABLE/NOT_DOWNLOADED → "Download a model"`, `RATE_LIMITED → "Rate limited"`, default → "Transcription failed". Localize via `locales/*.json`.
- Keep `#retry-btn`, but theme it with `--danger` and make it visually tied to the error glyph.

### 3.4 Consistency pass so states never overlap
- Ensure only one terminal state is visible at a time (clear `show-check`/`error` before setting a new one).
- Align the vertical stack: `#status-badge` (top:158) and `#retry-btn` (top:168) currently nearly overlap — move retry below the badge with proper spacing so both can show without collision.

---

## 4. Bugs / issues found during audit

1. **Error state not theme-aware** (§2.1) — error is invisible/wrong-colored on Ocean/Aurora/Terminal. _Fix via `--danger`._
2. **Settings modal ignores active theme** — 27 crimson literals. _Fix via tokens._
3. **Inconsistent success greens** (`#4ade80` vs `#10b981`). _Unify to `--success`._
4. **Aurora theme ring mismatch** — the blob button morphs its border-radius, but `.sonar-ring/.spin-ring/.burst-ring` are only re-shaped for Ocean & Terminal, so Aurora's rings stay circular around a blob. _Add Aurora ring overrides._
5. **`#submit-icon` uses success-green while recording** — a green check during an active recording can read as "done." _Consider tinting it neutral/`--primary` to avoid confusing it with the success state._
6. **Badge/retry overlap** (§3.4).
7. **No failure audio/haptic-style cue** — success has a chime, failure has nothing (§3.3).
8. **`prefers-reduced-motion`** nukes ALL transitions globally (`transition-duration: .01ms !important`) — acceptable, but verify state changes (success/error) still read without motion (they rely on color/glyph, which is fine once §3 lands).
9. **Verify no duplicate/conflicting `const finishSoundCheckbox`** (declared around lines 1543 and 1889) — confirm they're function-scoped, not a redeclare error, during the JS cleanup pass.

---

## 5. File-by-file change list

- **`styles/base.css`**
  - Add semantic token block to `:root`.
  - Add `#mic-button.error` glyph/glow + `@keyframes error-shake`.
  - Add transcribing shimmer.
  - Swap hardcoded greens → `--success`.
- **`styles/widget.css`**
  - `#status-badge.err` → `--danger`; `.done` → `--success`.
  - Animated `busy` dots hook if using CSS.
- **`styles/settings.css`**
  - Replace all `rgba(230,57,70,…)` → `--primary` / `color-mix(...)`.
  - Replace greens → `--success`, ambers → `--warning`.
  - Re-position `#retry-btn` to avoid badge overlap; theme with `--danger`.
- **`styles/themes.css`**
  - Optionally per-theme `--danger`/`--success` tweaks (e.g. Terminal keeps neon).
  - Add Aurora ring border-radius overrides.
- **`index.html`**
  - Add `#error-icon` SVG (✕) inside the mic button next to `#check-icon`.
  - Minor: normalize the mixed-indentation Language section.
- **`renderer.js`**
  - `setStatus`: support animated busy dots; ensure single terminal state.
  - Success path: add success-ripple hook; keep chime.
  - Failure path: add `micBtn.classList.add('error')` + timed removal, play error tone, use richer per-code status text.
  - Extend the code→message map; ensure retry button positioned/shown consistently.
- **`locales/en.json` / `es.json` / `zh.json`**
  - Add the new status strings (`status.NO_SPEECH` exists; add the rest) so feedback is localized.

---

## 6. Execution phases

1. **Tokens & theme unification** — add semantic tokens; de-hardcode settings.css; wire `--danger`/`--success`/`--warning`. (Foundational; unblocks the rest.)
2. **Failure feedback** — error glyph, shake, `--danger` badge, error tone, per-code messages + locales.
3. **Transcribing + success polish** — busy dots/shimmer, success ripple, unified green.
4. **Consistency & bug sweep** — badge/retry layout, Aurora rings, submit-icon color, single-terminal-state guard, JS cleanup (item 9).
5. **Verify** — `npm run check`, `npm run check:i18n`, `npm test`; manual pass of each state across all 4 widget styles (Crimson/Ocean/Aurora/Terminal) confirming feedback is clear and on-theme.

---

## 7. Acceptance criteria

- Transcribing, success, and failure are each **instantly distinguishable** (color + glyph + motion + optional sound).
- **No hardcoded crimson** remains in settings.css; the whole UI (widget + settings) recolors correctly for all 4 themes.
- Failure always reads as an error (dedicated `--danger`) on every theme.
- No overlapping/clipped feedback elements; rings match button shape on every theme.
- All checks/tests pass; new strings localized in en/es/zh.
