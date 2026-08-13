# VoiceToClipboard — Improvement Plan (v4.1.x hardening pass)

> Tailored to the owner's 10 answers on 2026-08-13. This is the working plan for the
> "improve everything" pass. Items are marked **[DONE]** / **[TODO]** and ordered by priority.

## Decisions from the Q&A

1. **Model integrity (C1):** pin real hashes **now** — `sha256` (archive) + `fileHashes`
   (mirror per-file) for all six models.
2. **Priority areas:** all of them — Security hardening, UI & animations, Performance/RAM,
   Packaging & portability, Docs & tests.
3. **Multi-key auth:** in practice one effective key (env + settings, env-grabbed). Make the
   auth handling robust regardless: skip a rejected key, continue to the rest, return
   `AUTH_ERROR` only after every key fails.
4. **Unicode autotype clipboard:** leave the user's clipboard untouched (professional + matches
   the documented "preserves clipboard" promise). **[DONE]**
5. **Dead code:** remove VoskAdapter + `vosk-koffi` **fully** (code + dependency + asarUnpack),
   and trim unreachable sherpa backend branches. Add `koffi` as a direct dependency (it is
   required by `win32.js`, `koffi-asar-fix.js`, `ort-preload.js` but only pulled in transitively
   via vosk-koffi today).
6. **Animation style:** **Moderate** — current level plus a few tasteful entrance/hover effects.
7. **History default:** **opt-in (off)** — keep config default `false`; remove the misleading
   `checked` attribute from `history-enabled-checkbox` in `index.html`.
8. **Docs drift:** just update `AGENTS.md` to match the shipped registry (no drift test).
9. **Tests:** keep the existing suite and add new tests with the current `node:test` setup.
10. **Packaging extras (plan2 leftovers):** none selected — compression, CI size guard, lite
    build, and ORT memory options stay out of scope for now.

## Status board

### A. Security & integrity
- [x] HTTPS-only downloads + redirects (`stt/model-cache.js`).
- [x] Archive/file sha256 verification plumbing (`verifyArchiveIntegrity` / `verifyMirrorFile`),
      wired into install, hash recorded in `installation.json`, exported + tested.
- [x] **Pin real hashes now** — `sha256` + `fileHashes` filled for all six models in
      `stt/model-registry.js` (fetched live from the GitHub release digests + HF LFS oids).
      Registry test asserts every model has a valid 64-hex `sha256` and full mirror `fileHashes`.
- [x] Gemini auth errors fail fast → `AUTH_ERROR` + i18n + status mapping.
- [x] Make auth handling skip-and-continue across keys (multi-key safe) — `AUTH_ERROR` only after
      every usable key fails auth; failed keys are skipped for the run.
- [x] Sync config flush on quit (no lost settings).
- [x] History write serialization (`mutateHistory`).
- [x] Audio size guard computes bytes correctly.
- [x] Bubble window `secureWebContents`.
- [x] API-key cooldowns keyed by sha256 hash (no plaintext keys as property names).
- [x] Error sanitizer broadened (`x-goog-api-key`, `x-api-key`, `api_key`, bare `Bearer`).
- [x] Logger best-effort wording + in-session rotation (`app.log` → `app.log.1`).

### B. UI & animations (moderate)
- [x] History card entrance + delete-out animations.
- [x] Paste bubble springy entrance + reduced-motion guard.
- [x] A few more tasteful accents: settings-window section entrance stagger, style-swatch hover
      elevation, smoother status-badge color/dot transitions.

### C. Performance / RAM (already mostly shipped in `9cfd103`)
- [x] Lazy native STT loading, idle-unload timer, deferred unload, `--max-old-space-size=256`.
- [x] Remove dead `vosk-koffi` native load path + unreachable sherpa branches
      (`parakeet`, `nemo-ctc`, `omnilingual`).

### D. Packaging & portability
- [x] Portable data dir (`PORTABLE_EXECUTABLE_DIR`).
- [x] Drop `vosk-koffi` from dependencies + `asarUnpack`; add `koffi` as a direct dependency
      (lockfile re-synced via `npm install`).

### E. Docs & tests
- [x] Update `AGENTS.md` to match `stt/model-registry.js` (deps, archive extraction, verified
      wording now notes pinned sha256; RAM/tier figures already matched).
- [x] New tests: HTTPS-only rejection; integrity verification.
- [x] New tests: registry hash coverage; sanitizer header/bearer patterns (no new config keys
      were added, so no new migration test needed).

## §1 — Hash-pinning strategy (the "now" item)

Preferred order (fast → slow, no 2.1 GB download unless an API lacks the data):

1. **GitHub release asset `digest`** — `GET https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/asr-models`
   returns an `assets[]` array; each asset carries `name` and (since ~2023) a `digest` field that
   is the sha256 of the uploaded archive. Match `archiveName` → `sha256`.
2. **Hugging Face LFS oid** — for each `mirrorBase`, `GET https://huggingface.co/api/models/{repo}/tree/main`
   returns per-file `oid` (sha256) and `path`. Map `expectedFiles` leaf names → `fileHashes`.
3. **Fallback:** if an API omits the digest/oid, download that one archive and `hashFile()` it
   locally (the verifier already computes sha256), then record the value.

Validation: a new `tests` assertion that every registry entry has a 64-hex `sha256`, and every
model with a `mirrorBase` has `fileHashes` for all `expectedFiles`. No runtime behavior changes
beyond the verifier now actually enforcing.

## §2 — Dead-code removal (vosk)

- `stt/index.js`: delete the `vosk` getter, the `backend === 'vosk'` branch, and the `_vosk`
  cleanup in `remove()` / `unloadAll()`.
- Delete `stt/vosk-adapter.js`.
- `stt/sherpa-adapter.js`: remove unreachable branches — `parakeet`, `nemo-ctc`, `omnilingual`
  (no registry entry uses them; the registry backends are moonshine, nemo-transducer,
  sense-voice, whisper, fire-red-asr-ctc).
- `package.json`: remove `vosk-koffi`; add `koffi` (version = the one vosk-koffi pulled in).
- `asarUnpack`: remove `node_modules/vosk-koffi/**/*`; keep `node_modules/koffi/**/*`.
- `npm install` (or `npm uninstall vosk-koffi` + `npm install koffi@…`) to sync the lockfile.
- Verify native loading still works: `koffi` loads `user32.dll` in `win32.js` and the sherpa DLLs
  via `ort-preload.js`; the `koffi-asar-fix` ordering (before `preloadOrt`) must be preserved.

## §3 — Multi-key auth (skip-and-continue)

In `main.js` `geminiTranscriber`: on `isAuthError(error)`, mark that key as unusable for this run
(skip it), continue to the next key; if every usable key fails auth, return
`{ success:false, code:'AUTH_ERROR' }`. Keep the single-key case identical to today.

## §4 — Docs (AGENTS.md)

Reconcile with the registry: six models (moonshine / nemo-transducer / sense-voice /
whisper-small / whisper-turbo / fire-red-asr-ctc), correct RAM figures (tiny 290 / mini 270 /
zh-light 400 / light 550 / big 950 / zh-big 1.1 GB), default tier = `light`, and soften the
"verified" claim to "has a pinned sha256 once the hash pass lands".

## §5 — Verification (after each change)

```bash
npm run check        # syntax OK
npm run check:i18n   # en/es/zh parity
npm test             # existing + new tests green
```

Manual (when runnable): dictation cycle still works; Unicode autotype leaves clipboard alone;
a bad Gemini key reports INVALID API KEY fast; a bad model hash aborts install.
