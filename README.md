# 🎙️ VoiceToClipboard

> **The ultimate, ultra-lightweight, floating voice-to-clipboard assistant powered by Google Gemini Multimodal AI.**

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/electron-v43.2.0-brightgreen)
![Gemini AI](https://img.shields.io/badge/AI-Gemini%202.5%20Flash-orange)

VoiceToClipboard is a clean, minimal Windows overlay app designed for maximum efficiency. It floats unobtrusively on your screen, shows live real-time "lyrics-style" subtitles as you speak, transcribes your voice with state-of-the-art Gemini AI accuracy, and automatically copies the result directly to your clipboard.

---

## ✨ Features

- ⚡ **Zero-Bloat & Lightweight:** Built using native Web Audio & Electron APIs. No heavy command-line audio tools (`sox`, `ffmpeg`) required!
- ⌨️ **Global Shortcut (`Ctrl+Alt+V`):** Trigger voice recording from anywhere on Windows without switching windows.
- 💬 **Live Floating Subtitles:** Instant real-time visual feedback under the widget as you speak.
- 🤖 **Gemini Multimodal STT:** High-precision transcription powered by `gemini-2.5-flash` with automatic multi-language detection.
- 🎨 **Modern Windows 11 Glassmorphism:** Transparent, frameless, draggable overlay with smooth circular audio visualizers and glowing red pulse animation.
- 🔔 **Synthesized Audio Feedback:** Subtle audio cues (beeps) when recording starts and finishes so you know it's working even in full-screen apps.
- 📌 **System Tray & Window Persistence:** Minimizes to system tray and remembers your preferred widget position on screen.
- 🔑 **Plug & Play Config:** Set your `GEMINI_API_KEY` via Windows system environment variables or directly inside the app's settings UI.

---

## ⌨️ Shortcuts & Controls

| Action | Shortcut / Control |
| :--- | :--- |
| **Start / Stop Recording** | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>V</kbd> or click the Mic Button |
| **Move Widget** | Drag anywhere on the widget window |
| **Open Settings** | Hover over widget and click ⚙️ or Right-Click Tray Icon |
| **Quit App** | Hover over widget and click ✕ or Right-Click Tray Icon -> Quit |

---

## 🚀 Quick Start

### 1. Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/YOUR-USERNAME/VoiceToClipboard.git
cd VoiceToClipboard
npm install
```

### 2. Configure API Key
You can set your Gemini API key in one of two easy ways:

- **Option A (In-App UI - Recommended):** Run `npm start`. Click the ⚙️ settings icon on the app overlay, paste your key, and click **Save Key**.
- **Option B (Windows Environment Variable):** Open PowerShell or CMD and run:
  ```cmd
  setx GEMINI_API_KEY "your_actual_gemini_api_key"
  ```
  *(Restart your terminal/app after running `setx`)*

### 3. Launch App
```bash
npm start
```

---

## 📦 Building Standalone Executable

To generate a portable Windows installer (`.exe`):
```bash
npm run build
```
The installer will be generated inside the `dist/` folder.

---

## 🛠️ Tech Stack

- **Framework:** Electron (Node.js & Chromium)
- **AI Model:** Google Gen AI (`@google/genai` - `gemini-2.5-flash`)
- **Audio & Subtitles:** Web Audio API & Web Speech API (`webkitSpeechRecognition`)
- **Packaging:** `electron-builder`

---

## 📜 License

Distributed under the MIT License. See [`LICENSE`](LICENSE) for more information.
