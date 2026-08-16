# v4.1.6 — Frontend Visuals Reverted to v4.1.1
# (List of visual changes from 4.1.3–4.1.5 that were DELIBERATELY NOT implemented)

Applies to built **v4.1.6** on branch `v4.1.6`.

## Intent (from the user)
> "everything frontend related keep as 4.1.1 literally everything for now, for the rest
> keep as is and improve ... make sure everything is same for now, keep visual changes
> listed after u finish the task but dont implement them."

The backend (src/main, stt, renderer logic wiring) keeps the modular 4.1.5 architecture and
its improvements; the FRONTEND VISUAL PRESENTATION was reverted to look **exactly like v4.1.1**.

## What was reverted (back to v4.1.1 exactly)
1. **styles/base.css**            → v4.1.1 (old idle chrome, old active/transcribe/green-success look)
2. **styles/widget.css**          → v4.1.1 (old status badge + `spin` keyframe, old top-bar)
3. **styles/themes.css**          → v4.1.1 (old idle `--primary` hues & single-surface vars)
4. **styles/settings.css**        → v4.1.1 (old settings surface, old picker, no sticky titles)
5. **index.html markup**          → v4.1.1 visible markup (removed first-run tour, info-hint ⓘ,
                                     switch-label-group wrappers, gemini single-key focus, hard-coded
                                     red style-swatch). Kept the modular `<script>` modules so the
                                     app still boots on the modular backend.
6. **bubble.html / bubble-preload.js / bubble-renderer.js** → v4.1.1 (inline-styled bubble, no
                                     theme-bootstrap, no theme-aware reskin)
7. **Deleted** `styles/bubble.css`, `bubble-theme-bootstrap.js`, `src/renderer/theme-bootstrap.js`
                                     (4.1.5-only theme pre-paint system)
8. **src/renderer/visualizer.js color constants** → v4.1.1 palette
   (ocean #0ea5e9, aurora #a855f7, terminal #00ff66/#55ff99, crimson #e63946/#ff4d4d)
9. Removed `tests/theme-contract.test.js` and 3 tests in `main-modules.test.js` that tested the
   4.1.5-only look (theme-bootstrap, first-run tour, sticky titles / focus trap).

## VISUAL CHANGES EXCLUDED (NOT implemented — listed for the user)
These appeared in 4.1.3–4.1.5 and are intentionally absent in 4.1.6 because the frontend was
reverted to v4.1.1:

### Widget / mic
- 4.1.5 'high-contrast full-surface theme system' (per-theme `--canvas/--surface/--text-dim`).
- 4.1.5 idle `--primary` hues (crimson #ff3b4e, ocean #06b6d4, aurora #c084fc, terminal #00ff66).
- 4.1.5 recording gradient fill + strong glow + white icon overlays per theme.
- 4.1.5 animation: comet spinner (conic-gradient) + `transcribing-breathe` + static halo.
- 4.1.5 theme-colored success tick (uses `var(--primary)`) instead of the old green success glow.
- 4.1.5 per-theme hover / focus-visible / show-check / show-error states.
- 4.1.5 `status-spin` keyframe fix (busy dot centering) — reverted to v4.1.1 `spin`.
- 4.1.5 newer idle opacity default 65% + blur(1.5px) — v4.1.1 idle fade is opacity-only at 60%.

### Settings window
- 4.1.5 compact ⓘ info-hint tooltips replacing the helper text paragraphs.
- 4.1.5 '⚡ Fast' model chip and removal of the '⭐' prefix on the Recommended chip
  (restored v4.1.1 star + Best-quality chip only).
- 4.1.5 history empty-state icons/search-hint — restored v4.1.1's plain
  `.history-empty-msg` text (`history.empty` / `history.emptySearch`).
- 4.1.5 `switch-label-group` inline layout.
- 4.1.5 sticky `.settings-section-title`.
- 4.1.5 modal focus-trap + `lastFocusedBeforeSettings` keyboard handling.
- 4.1.5 'Additions kept, styled old' blocks (mo-chip-fast, info-hint, switch-label-group, hint-tooltip).

### New features (kept in backend logic but their VISUAL affordances are v4.1.1 / minimal)
- First-run welcome tour (welcome.* keys + first-run-tour CSS cause code is guarded/no-op).
- Theme pre-paint bootstrap (getInitialAppearance / theme-bootstrap) — backend IPCs remain, no DOM effect.
- Gemini cooldown note (`gemini.cooldown*`) & GEMINI_FALLBACK status text — status set via setStatus only.

## What is KEPT (modular backend + improvements, "the rest")
- Modular src/main + src/renderer + src/main windows/hotkeys/gemini/config/history/recordings/delivery.
- Single Gemini key, model hash integrity, background startup prep, graceful shutdown contract,
  foreground polling for all output modes, toast paste once-guard, hotkey capture UX, click-through
  hysteresis, auto-stop truncation fix, mic calibration hardening, history opt-in, history search
  debounce, renderer logging, config migration split, lazy ZIP. All 61 tests + syntax + i18n pass.
