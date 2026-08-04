require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const record = require('node-record-lpcm16');
const clipboardy = require('clipboardy');
const fs = require('fs');
const readline = require('readline');
const os = require('os');
const path = require('path');

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const TEMP_AUDIO_FILE = path.join(os.tmpdir(), 'voice_input.wav');

// Create readline interface for terminal interaction
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function transcribeAudio(filePath) {
    try {
        console.log("Analyzing audio with Gemini...");
        
        // Upload the audio file to Gemini
        const uploadResult = await ai.files.upload({
            file: filePath,
            mimeType: 'audio/wav',
        });
        
        // Generate content from the audio
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                uploadResult, 
                "Transcribe this audio precisely. Return ONLY the transcribed text. Do not add conversational filler."
            ]
        });
        
        const transcript = response.text().trim();
        
        if (transcript) {
             console.log(`\n--- Transcription ---\n${transcript}\n---------------------\n`);
             // Copy to clipboard
             await clipboardy.write(transcript);
             console.log("✅ Successfully copied to clipboard!");
        } else {
             console.log("❌ No speech detected.");
        }
        
    } catch (error) {
        console.error("❌ Error during transcription:", error.message);
    } finally {
        // Clean up temporary file
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
}

function startRecording() {
    console.log("🎤 Recording... Press ENTER to stop.");
    
    const file = fs.createWriteStream(TEMP_AUDIO_FILE, { encoding: 'binary' });
    
    // Start recording, specifically targeting sox/ffmpeg for windows compat
    const recording = record.record({
        sampleRate: 16000,
        channels: 1,
        // SoX command usually fails on base windows unless installed, so we fallback to a simple generic if needed, 
        // but 'sox' is default. We will let the library handle the default binary selection which tries SoX first.
    });
    
    recording.stream().pipe(file);
    
    rl.on('line', async () => {
        recording.stop();
        rl.close();
        
        console.log("⏹️ Recording stopped. Processing...");
        await transcribeAudio(TEMP_AUDIO_FILE);
    });
}

// Check for API Key
if (!process.env.GEMINI_API_KEY) {
    console.error("❌ Error: GEMINI_API_KEY is not set in the .env file.");
    process.exit(1);
}

// Start the app
startRecording();
