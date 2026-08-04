# VoiceToClipboard STT Tool

## Project Goal
Create a super simple, lightweight Windows software that records voice from the microphone, uses the Gemini Multimodal API to convert Speech-to-Text (STT), and automatically copies the transcribed text directly to the user's clipboard. It is designed to be extremely memory-efficient.

## Current State
- **Language/Environment:** Node.js (v24.18.1).
- **Directory:** `C:\Users\lavvo\Documents\VoiceToClipboard`
- **Core Logic:** Implemented in `index.js`.
- **Dependencies Installed:** 
  - `@google/genai` (For Gemini STT interaction)
  - `clipboardy` (To handle clipboard operations cross-platform)
  - `node-record-lpcm16` (To handle microphone recording)
  - `dotenv` (For local environment variables)
- **Gitignore:** Created and ignoring `node_modules/` and `.env`.

## What Needs to be Done (For the Next Agent)
1. **API Key Setup:** A `.env` file needs to be created containing `GEMINI_API_KEY=your_key_here`.
2. **Audio Tooling on Windows:** `node-record-lpcm16` relies on command-line audio tools like `sox` or `ffmpeg`. Windows doesn't always have a default fallback that works perfectly. If the recording fails when running `npm start`, you may need to ensure `sox` or `ffmpeg` is available on the system PATH and configure the recorder options in `index.js` to target it correctly.
3. **Run & Test:** Execute `node index.js` (or `npm start`) and verify that pressing ENTER successfully stops recording, sends the payload to Gemini, and copies the resulting transcript to the clipboard.

## Security Rule
DO NOT leak, print, or expose the `GEMINI_API_KEY` in any logs, chat messages, or console outputs.
