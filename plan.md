# VoiceToClipboard — Widget Style Transformation Plan + Bug Findings

> **Scope of this doc:** (1) a bold plan to make **Widget Styles** feel like *completely different widgets*
> — not just recolors — and (2) bugs found while reading the styling/theming code.
> **No application code was changed** producing this document; it is a plan + findings only.

---

## 0. Where Widget Styles are today (verified by reading the code)

- Styles live as **CSS-variable-only overrides**: `styles/themes.css` defines
  `:root[data-widget-style="ocean"]` and `:root[data-widget-style="aurora"]`, each swapping just **6 vars**
  (`--primary`, `--primary-hover`, `--bg-glass`, `--border-glass`, `--text-main`, `--text-dim`).
  `crimson` is the base `:root` in `base.css`.
- Applied by `renderer.js` → `applyWidgetStyle()` setting `document.documentElement[data-widget-style]`.
- Persisted as `widgetStyle` in config; broadcast so both windows update live.
- The allowed-style list `['crimson','ocean','aurora']` is **hardcoded in 5 places**
  (`main.js` ×3, `renderer.js` `setWidgetStyle` + `applyWidgetStyle`, plus the `settings-changed` handler).

**Why it feels samey (the user's complaint):** every style shares the *same* 150×150 layout, the *same*
round 60px mic button, the *same* aura/sonar/spin-ring animations, and — worse — most of those effects are
**hardcoded crimson** and never read `--primary` (see Bug B1), so switching style barely changes anything.

---

## 1. The plan: turn "themes" into real "transformations"

Goal: each Widget Style should change **shape, layout, motion, and texture** — so the widget reads as a
different object, while keeping the same behavior (record → transcribe → copy) and accessibility.

### Phase A — Foundation (do first; unlocks everything else)

1. **Single source of truth for styles.** Create one `WIDGET_STYLES` list (e.g. in a small shared module or
   `main.js` constant reused by validation) and drive the 5 hardcoded checks + the settings swatches from it.
   Adding a style should mean editing **one** list, not five.
2. **Tokenize the look** so a style can change more than color. Introduce style tokens (CSS custom props)
   consumed by `base.css`/`widget.css` instead of hardcoded values:
   - `--mic-size`, `--mic-radius` (circle ↔ squircle ↔ pill ↔ blob), `--container-size`
   - `--fx-color` / all glows, auras, sonar, spin-ring, burst switch from literal crimson → `var(--primary)`
   - `--motion-profile` hooks (bounce vs glide vs glitch) via per-style keyframe overrides
   - `--viz-mode` data attribute read by the visualizer canvas to pick a draw routine
3. **Per-style CSS blocks, not just variables.** In `themes.css`, allow
   `:root[data-widget-style="x"] #mic-button { … }`, `… #status-badge { … }`, `… .sonar-ring { … }` etc.
   so each style can restyle *structure and animation*, not only palette.
4. **Visualizer becomes style-aware.** The canvas draw loop reads the active `--viz-mode`
   (e.g. `rings` | `bars` | `waveform` | `particles`) and renders differently per style.

### Phase B — Ship 4 boldly different styles

Keep the names in the picker but make each a distinct *transformation*:

| Style | Shape & layout | Motion personality | Visualizer | Texture |
|-------|----------------|--------------------|-----------|---------|
| **Crimson — "Pulse Orb"** (default) | Round 60px orb, centered, current layout | Springy bounce, breathing aura + sonar rings | Radiating rings | Dark glass, red glow |
| **Ocean — "Tide Bar"** | Collapses to a **thin horizontal capsule/pill** (wide, short), mic at the left, status text inline | Smooth glide/slide, no bounce; gentle left-right sway | **Waveform bars** scrolling like a tide | Frosted blue glass, soft |
| **Aurora — "Liquid Blob"** | **Organic morphing blob** (animated `border-radius` morph), larger, off-center | Slow gooey morph, fluid scale; aura replaced by drifting gradient | **Particle/bloom** field | Purple gradient, blurred bloom |
| **New — "Neon Terminal"** | **Sharp rounded-rectangle** panel, monospace status line with typewriter caret | Snappy/glitch (step easing), scanline sweep instead of aura | **Equalizer bars**, blocky | Flat dark, neon outline, CRT scanline |

Each style defines its own: container shape/size, mic-button `border-radius` & size, badge position/typography,
which recording FX are on (sonar vs scanline vs blob-morph vs bars), and its keyframe set. This is the
"super different" transformation the user asked for — structure + motion, not just hue.

### Phase C — Settings & polish

- **Swatches preview the shape**, not just a color dot: render a mini shape (orb / bar / blob / rounded panel)
  so users see the transformation before choosing.
- Keep **`prefers-reduced-motion`** honored — the reduce block in `themes.css` already neutralizes animations;
  verify the new per-style animations are also covered (they will be, since it targets `*`).
- Add i18n keys for any new style name (e.g. "Neon Terminal") in `locales/en|es|zh.json` and keep parity
  (`npm run check:i18n`).

### Phase D — Verify

- Switch each style live from Settings → widget re-shapes instantly (layout, mic shape, animation, visualizer).
- Recording FX now take the style's color (no leftover red on Ocean/Aurora — see Bug B1).
- `npm run check`, `npm run check:i18n`, `npm test` stay green; reduced-motion still calms all styles.

---

## 2. Bugs found during this review

### 🔴 B1 — Recording FX are hardcoded crimson and ignore the active style (real visual bug)
`styles/base.css` contains **~24** literal crimson color references (`rgba(230,57,70,…)`, `#e63946`,
`#c92a37`, `#ff4d4d`, `#ff8a8a`, `255,140,150`) across `mic-live`, `idle-pulse`, `mic-pop`, `#mic-aura`,
`.sonar-ring`/`sonar`, `.spin-ring` (+ transcribing variant), `#status-badge .rec-dot`, and `.burst-ring`
(`widget.css` adds ~2 more in the status badge). None use `var(--primary)`.
**Effect:** selecting **Ocean** or **Aurora** only recolors the mic button's base/border and text; the
**glow, aura, sonar rings, spinner, success/burst, and rec-dot stay red** — so themes look broken/half-applied.
**Fix:** replace those literals with `var(--primary)` / `var(--primary-hover)` (or a dedicated `--fx-color`).
This is a prerequisite for Phase A anyway.

### 🟠 B2 — Style allow-list duplicated in 5 places → silent reset trap
`['crimson','ocean','aurora']` is hardcoded in `main.js` (×3: startup normalize, `settings-changed` build,
`save-stt-config` merge) and `renderer.js` (`setWidgetStyle`, `applyWidgetStyle`, and the `settings-changed`
handler). Any new style added without editing **all** of them is silently coerced back to `crimson`.
**Fix:** one shared `WIDGET_STYLES` constant used everywhere (see Phase A.1).

### 🟡 B3 — Swatch dot colors don't match the actual theme palette
`styles/settings.css` swatches use ad-hoc gradients: `.swatch-ocean` = `#2dd4bf→#38bdf8`,
`.swatch-aurora` = `#a855f7→#818cf8`, but the real theme primaries in `themes.css` are Ocean `#0ea5e9` and
Aurora `#a855f7→#c084fc`. The preview dot doesn't represent the applied color (Ocean especially: teal dot,
sky-blue theme).
**Fix:** derive swatch previews from the same tokens as the themes (and, per Phase C, preview shape too).

### 🟢 B4 — Note: the previous plan's two "CRITICAL" bugs are already fixed
The prior `plan.md` flagged `renderer.js` using `require()` (C1) and mismatched IPC payload signatures (C2).
Current `renderer.js` uses no `require`, and the handlers already use the payload-first signatures
(`gemini-fallback(model)`, `widget-hover(payload)`, `settings-changed(snapshot)`, `download-progress` via
`progressListener`). Removed from the active list — kept here only so they aren't re-investigated.

---

## 3. Suggested order
1. **B1 + B2** (var-ize FX colors, single style list) — foundation for real transformations.
2. **Phase A** token layer + style-aware visualizer.
3. **Phase B** ship the 4 transformed styles.
4. **B3 + Phase C** swatch previews, i18n, reduced-motion check.
5. **Phase D** verify.
