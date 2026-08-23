# Security Policy

## Reporting a vulnerability
Please email the maintainer or open a **private** security advisory on GitHub; do not open a public issue for security reports. Include steps to reproduce and, if possible, a sanitized `app.log` (use **Settings → Copy diagnostics**, which already redacts secrets).

## What we never do
- We never log, print, transmit, or store your `GEMINI_API_KEY` anywhere other than the local `config.json` (or the environment). Log output is run through a redaction sanitizer.
- We never commit or bundle model archives, installers, or your config.

## Why Windows / SmartScreen may warn
VoiceToClipboard is distributed as an **unsigned / self-signed** binary. SmartScreen's warning is reputation-based, not a malware verdict. Ways to reduce or eliminate prompts:

1. **Code-sign the releases.** An Authenticode (OV or EV) certificate applied to the installer and `*.exe`s is the single most effective fix — it replaces "Unknown publisher" with your publisher name and, for EV certs, builds SmartScreen reputation fast.
   - electron-builder picks up a cert automatically if set via env (do not commit it):
     `CSC_LINK` (path to `.pfx`) and `CSC_KEY_PASSWORD`, or via a Windows cert in the user store.
2. **Build reputation for unsigned releases.** More downloads of a *stable, unchanged* signed-with-nothing binary slowly whiten it; re-signing or bumping resets it. **Avoid tiny metadata churn between releases** so the same binary accumulates reputation.
3. **Ship `SHA256SUMS.txt`** so users can verify the exact bytes; some AVs are less aggressive when users/IT can confirm provenance.
4. **Install to user-writable paths** (this app uses per-user NSIS, no admin prompt), which reduces heuristic suspicion vs. system-level installers.
5. **Submit false positives** to Microsoft and to the specific AV vendors once signed — unsigned binaries are the #1 cause of heuristic flags.

> Best path: obtain an Authenticode code-signing certificate and set `CSC_LINK`/`CSC_KEY_PASSWORD` in CI secrets; the existing `npm run build` will sign automatically.
