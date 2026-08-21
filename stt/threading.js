// Shared CPU-parallelism tuning for ONNX Runtime (sherpa-onnx) on x64.
//
// Goal (user ask): make transcription FASTER WITHOUT more RAM. ORT already
// parallelizes within an op; the previous blanket `min(4, cpus-1)` cap underused
// 8-core desktop CPUs and starved 16-core+ ones. This picks a lane-matched count
// per model size and keeps it out of the UI (it is not a user setting).
const os = require('node:os');

let cachedCores = null;
function physicalCores() {
    if (cachedCores === null) cachedCores = Math.max(1, os.cpus().length);
    return cachedCores;
}

// Bigger models benefit from more lanes; tiny models on many threads actually
// get slower (thread-pool contention + memory bandwidth). Capped, so we never
// blow past what the chip can feed. RAM use is unchanged: threads schedule the
// same tensors, they do not duplicate the model weights.
// `backend` is optional (registry backend id, e.g. 'whisper'): registry keys no
// longer always carry the family name (omni-multilingual IS Whisper), so the
// adapter passes the backend to keep lane matching accurate.
function numThreadsFor(modelKey = '', backend = '') {
    const cores = physicalCores();
    const big = /(big|large|whisper)/i.test(`${modelKey} ${backend}`);
    const laneEstimate = big ? 8 : 6;
    return Math.max(2, Math.min(cores, laneEstimate));
}

module.exports = { numThreadsFor, physicalCores };
