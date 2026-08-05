<p align="center">
  <img src="build/icon.png" width="128" alt="VoiceToClipboard icon">
</p>

<h1 align="center">🎙️ VoiceToClipboard</h1>

> [!NOTE]
> **Project Status:** 🟢 **Working / Functional**  
> *This status must not be changed by AI unless explicitly instructed by the repository owner.*


> **A featherweight, always-on-top Windows widget that turns your microphone into an instant clipboard.**
> Speak — it transcribes with Google Gemini and copies the text to your clipboard automatically.

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![Status](https://img.shields.io/badge/status-stable-brightgreen.svg)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)
![Electron](https://img.shields.io/badge/Electron-v43.2.0-brightgreen)
![AI Model](https://img.shields.io/badge/AI-Gemini%202.5%20Flash-orange)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

---

## ✨ Highlights

- ✅ **Stable & production-ready** — v1.0.0, no external audio tools required (`ffmpeg`/`sox` free)
- ⚡ **Zero-bloat** — a tiny frameless widget powered by native Web Audio API & Electron
- ⌨️ **Global shortcut** — record anywhere with `Ctrl + Alt + V`
- 🤖 **Gemini Multimodal STT** — high-accuracy transcription with automatic language detection
- 🖱️ **Drag anywhere** — hold the mic button and drag to reposition; quick click to record
- ⏹️ **Submit or cancel** — click the ✓ to finish & transcribe; press `Esc` to discard
- 🪟 **Click-through design** — transparent areas never block your mouse; clicks pass straight through to apps underneath
- 🎨 **Minimal glass UI** — breathing glow, sonar rings, spinner feedback, and a hand-drawn checkmark on success
- 📌 **System tray** — always-on-top toggle, tray controls, and window position memory

---

## ⌨️ Controls

| Action | Shortcut / Control |
| :--- | :--- |
| **Start recording** | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>V</kbd> or click the mic button |
| **Finish & transcribe** | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>V</kbd> or click the ✓ button (while recording) |
| **Cancel recording** | Press <kbd>Esc</kbd> |
| **Move the widget** | Hold-click the mic button and drag |
| **Open settings** | Hover the widget and click ⚙️, or right-click the tray icon |
| **Quit app** | Hover the widget and click ✕, or tray icon → Quit |

---

## 🚀 Quick Start

### 1. Requirements

- **Windows 10/11**
- **Node.js 18+** (only needed for development/building)
- **A free Google AI Studio API key** — grab one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

### 2. Install

```bash
git clone https://github.com/TruftedBug89/VoiceToClipboard.git
cd VoiceToClipboard
npm install
```

### 3. Configure your API key

> **Prerequisite:** The app needs a **Google AI Studio API key** to transcribe. It's free — create one at [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey).

Set it in one of two ways:

- **Option A — In-app (recommended):** Run `npm start`, click ⚙️ on the widget, paste your key, and click **Save Key**.
- **Option B — Environment variable:**
  ```cmd
  setx GEMINI_API_KEY "your_actual_gemini_api_key"
  ```
  *(Restart your terminal/app after running `setx`.)*

### 4. Run

```bash
npm start
```

---

## 📦 Building a Standalone Executable

### Unpacked app (no installation)

```bash
npm run pack
```

Produces `dist\win-unpacked\VoiceToClipboard.exe` — run it directly with a double-click (no terminal needed).
Right-click the exe (or its running taskbar button) and choose **Pin to taskbar** for one-click access.

### Windows installer

```bash
npm run build
```

Produces `dist\VoiceToClipboard-1.0.0-Setup.exe` — a one-click NSIS installer with a Start Menu
shortcut and uninstaller. Installed shortcuts pin cleanly to the taskbar.

> Regenerate the app icon anytime with `npm run icon` (writes `build/icon.ico` + `build/icon.png`, no dependencies).

---

## 🛠️ How It Works

1. You start recording (shortcut or mic click) — audio is captured with the native **Web Audio API**.
2. Press the shortcut again to finish: the clip is sent to **Gemini 2.5 Flash** for transcription.
3. The transcript is written straight to your **clipboard** — ready to paste.
4. Prefer to start over? Press <kbd>Esc</kbd> to **cancel** — the audio is discarded instantly.

## 🧱 Tech Stack

| Layer | Technology |
| :--- | :--- |
| Framework | Electron (Node.js & Chromium) |
| AI Model | Google Gen AI (`@google/genai` — `gemini-2.5-flash`) |
| Audio capture | Web Audio API (`MediaRecorder`) |
| Packaging | `electron-builder` |

---

## 📜 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for details.
