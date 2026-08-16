# Long-Horizon Development Plan — VoiceToClipboard (post-4.1.6)

Authored by the future-task planning agent, 4.1.6 baseline.

## Current verified state (4.1.6 @ de7155d, branch v4.1.6)
- Frontend visuals restored to v4.1.1 (CSS/bubble/markup byte-identical; animations v4.1.1;
  modular visualizer palette). Modular renderer wiring preserved for the modular backend.
- Backend = new modular (single Gemini key, model hash integrity, auto-stop fix, hotkey UX, etc.).
- Tests: 61/61 pass · check-js: 51 files OK · i18n parity: en/es/zh 224 keys. App boots.
- dist/ holds only 4.1.4/4.1.5 installers — no 4.1.6 release built yet.

## Long-horizon tracks (do B first, then A)
### Track B — Download / model lifecycle UX + RAM guardrails (~2 sessions, medium)
- Resumable .part downloads + length/checksum validation; clear stale parts on version bump.
- Persist last-successful mirror for geo-fallback to reduce re-learning failover.
- Progress shows BOTH downloaded bytes and decompressed footprint (e.g. "1.9 GB on disk").
- First-run RAM-aware "recommend a model" wizard with 6-model registry + risky tag.
- Disk-space preflight before download; abort cleanly and reuse hygiene.js to free space.
Verify: kill mid-download -> resumes & checksum passes; mock RAM -> marker moves; tiny disk -> friendly block.

### Track A — Telemetry-free diagnostics & health center (~2-3 sessions, medium/large)
- src/main/diagnostics.js: OS/build, models vs expectedFiles, cache sizes, RAM ladder vs actual,
  ORT lanes, GPU/CPU, koffi/uiohook native status, IPC channel map.
- Redaction-safe "Export diagnostics" JSON + sanitized log bundle to Downloads (no telemetry).
- Read-only Diagnostics tab in Settings: subsystem checkmarks, cache/model sizes, clear-cache,
  integrity re-verify.
- In-memory failure counters (download retries, STT error types, VAD stops, autotype failures).
- CLI --self-test: mic probe, WAV round-trip, clipboard write/read, model load; pass/fail report.
Verify: tests green; --self-test all-pass on clean machine; export provably key-free; break a
model file -> integrity check flags it.

## Final-release (4.1.6) readiness checklist
1. Git hygiene: commit the 2 staged deletions (AI-HANDOFF-CONTEXT.md, VTC-4.1.6-VISUAL-REVERT.md);
   remove any untracked v411_*/scratch; re-verify package.json build.files whitelist.
2. npm ci from lockfile in a clean checkout (reproducibility).
3. node scripts/pack.js -> dist/win-unpacked: app.asar + app.asar.unpacked native DLLs
   (sherpa-onnx-win-x64, koffi, uiohook-napi) + koffi-asar-fix.js present. Smoke-test the exe.
4. Test local offline STT + Gemini path; hotkey + space-to-paste bubble; settings both modes.
5. node scripts/build.js -> -Setup.exe + -portable.exe; verify NSIS install + shortcut.
6. Create CHANGELOG.md (4.1.1 -> 4.1.6). Update ARCHITECTURE.md if IPC changed. Sync README.
7. Version 4.1.6, commit hygiene separately, tag v4.1.6, run CI on the tag, build installers.
8. Pre-ship smoke: cold start, first-run download verifies, paste into real app & game,
   idle-fade & themes render, app.log shows zero credentials.

## Open decisions for the user
1. Version: 4.1.6 vs 4.2.0 (visual revert is notable)? Affects tag/auto-update.
2. Keep or strip handoff/scratch files before release.
3. Auto-update via GitHub release now, or manual? (exe currently unsigned)
4. Code signing (SmartScreen warning): self-signed/test cert vs unsigned.
5. Track ordering: B first then A? Confirm "local diagnostics only, no telemetry" direction.
6. Add more locales (pt/fr/ja) before final or keep 3?
7. Should RAM-based model recommendation also consider whether the locale is model-covered?
