# Contributing to VoiceToClipboard

Thank you for your interest in contributing to **VoiceToClipboard**! We welcome contributions to make this the ultimate voice-to-text productivity tool.

## 🚀 Getting Started

1. **Fork the Repository** and clone your fork locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/VoiceToClipboard.git
   cd VoiceToClipboard
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Run in Development Mode**:
   ```bash
   npm start
   ```

## 🛠️ Code Structure

- `main.js`: Electron Main process handling window creation, global shortcuts, system tray, window position persistence, and Gemini API IPC calls.
- `index.html`: UI overlay featuring Windows 11 glassmorphism, responsive visualizer canvas, settings modal, and floating subtitles box.
- `renderer.js`: Frontend logic for Web Audio API audio visualizer, real-time speech recognition (`webkitSpeechRecognition`), synthesized audio cues, and IPC bridge.

## 📋 Guidelines

- Keep the app **super lightweight, zero-bloat, and fast**.
- Do not introduce heavy native audio dependencies (`sox`/`ffmpeg`). Rely on modern Web APIs where possible.
- Ensure security rules: **Never log, print, or leak API keys**.
- Test your changes on Windows before submitting a Pull Request.

## 📦 Building Standalone Installer

To test creating a standalone Windows installer:
```bash
npm run build
```
The executable will be generated inside the `dist/` directory.

Thank you for helping build great open-source tools!
