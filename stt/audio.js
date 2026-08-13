const WAV_HEADER_BYTES = 44;
const MAX_AUDIO_SECONDS = 15 * 60;

function toFloat32Array(value) {
    if (value instanceof Float32Array && value.byteOffset % 4 === 0) {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return new Float32Array(value.slice(0));
    }
    if (ArrayBuffer.isView(value)) {
        const slice = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        return new Float32Array(slice);
    }
    throw new Error('Invalid PCM audio buffer.');
}

function validatePcm(value, sampleRate = 16000) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
        throw new Error('Invalid audio sample rate.');
    }
    const samples = toFloat32Array(value);
    if (!samples.length) throw new Error('Audio buffer is empty.');
    if (samples.length / sampleRate > MAX_AUDIO_SECONDS) {
        throw new Error(`Recording exceeds the ${MAX_AUDIO_SECONDS / 60}-minute limit.`);
    }
    for (let i = 0; i < samples.length; i++) {
        if (!Number.isFinite(samples[i])) throw new Error('Audio buffer contains invalid samples.');
    }
    return samples;
}

function pcmToWav(value, sampleRate = 16000) {
    const samples = validatePcm(value, sampleRate);
    const buffer = Buffer.allocUnsafe(WAV_HEADER_BYTES + samples.length * 2);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + samples.length * 2, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(samples.length * 2, 40);

    for (let i = 0; i < samples.length; i++) {
        const sample = Math.max(-1, Math.min(1, samples[i]));
        buffer.writeInt16LE(sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), WAV_HEADER_BYTES + i * 2);
    }

    return buffer;
}

module.exports = {
    MAX_AUDIO_SECONDS,
    pcmToWav,
    toFloat32Array,
    validatePcm
};
