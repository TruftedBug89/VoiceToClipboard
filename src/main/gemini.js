// src/main/gemini.js
// Cloud Gemini STT client with failover ladder, 24h quota cooldowns, and prompt localization.

const { GoogleGenAI } = require('@google/genai');
const { getApiKeys, loadConfig, saveConfig, cooldownKey, getUiLanguage } = require('./config-store');
const { sanitizeErrorMessage } = require('../../stt/error-sanitizer');
const { logger } = require('../../logger');

const GEMINI_MODEL_LADDER = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
const GEMINI_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function isRateLimitError(err) {
    const status = err && (err.status || err.code);
    const msg = (err && (err.message || String(err))) || '';
    return status === 429 || status === 'RESOURCE_EXHAUSTED'
        || /rate.?limit|quota|RESOURCE_EXHAUSTED|429|too many requests|daily/i.test(msg);
}

function isAuthError(err) {
    const status = err && (err.status || err.code);
    const msg = (err && (err.message || String(err))) || '';
    if (status === 401 || status === 403) return true;
    return status === 400 && /api key|unauthorized|forbidden|permission|invalid.?key|authentication/i.test(msg);
}

function getPromptForLang(lang) {
    if (lang === 'es') {
        return 'Transcripción estricta de voz a texto. Devuelve SOLO las palabras exactas del audio, palabra por palabra, manteniendo los préstamos de otros idiomas (por ejemplo, palabras en español dentro de una frase en inglés) tal cual. Nunca añadas, corrijas, expliques ni respondas. Si no hay voz, no devuelvas nada.';
    }
    if (lang === 'zh') {
        return '严格的语音转文字。只输出音频中说出的话，逐字逐句，保持中英文混说（例如中文句子里的英文单词）原样不变。不要添加、删除、解释或回应任何内容。如果没有语音，则不输出任何内容。';
    }
    return 'Strict speech-to-text. Output ONLY the exact words spoken in the audio, verbatim, preserving code-switched words from other languages exactly as spoken. Never add, remove, explain, or respond. If there is no speech, output nothing.';
}

/**
 * Creates the Gemini transcriber callback for SttService.
 * @param {object} options
 * @param {(fallbackModel: string) => void} [options.onFallback] Callback on ladder fallback
 * @param {(text: string) => {typed?: boolean}} [options.onDeliver] Callback to deliver text
 * @returns {(request: {arrayBuffer: ArrayBuffer, mimeType?: string, uiLanguage?: string}) => Promise<object>}
 */
function createGeminiTranscriber({ onFallback = () => {}, onDeliver = () => ({}) } = {}) {
    return async function geminiTranscriber({ arrayBuffer, mimeType = 'audio/webm', uiLanguage }) {
        const keys = getApiKeys();
        if (keys.length === 0) return { success: false, code: 'NO_API_KEY', error: 'GEMINI_API_KEY is not configured.' };

        const buffer = Buffer.from(arrayBuffer);
        const lang = uiLanguage || getUiLanguage();

        const now = Date.now();
        const pruneCooldowns = (raw) => {
            const cd = { ...(raw || {}) };
            let changed = false;
            for (const [k, until] of Object.entries(cd)) {
                if (until <= now) { delete cd[k]; changed = true; }
            }
            return { cd, changed };
        };
        const { cd: modelCds, changed: mc } = pruneCooldowns(loadConfig().modelCooldowns);
        const { cd: keyCds, changed: kc } = pruneCooldowns(loadConfig().keyCooldowns);
        if (mc || kc) saveConfig({ modelCooldowns: modelCds, keyCooldowns: keyCds });

        const preferred = loadConfig().geminiModel || 'gemini-2.5-flash';
        const chain = [preferred, ...GEMINI_MODEL_LADDER.filter(m => m !== preferred)]
            .filter(m => !(modelCds[m] && modelCds[m] > now));
        const usableKeys = keys.filter(k => !(keyCds[cooldownKey(k)] && keyCds[cooldownKey(k)] > now));

        if (usableKeys.length === 0 || chain.length === 0) {
            const why = usableKeys.length === 0 && chain.length === 0
                ? 'All Gemini API keys and models are rate-limited'
                : usableKeys.length === 0
                    ? 'All Gemini API keys are rate-limited'
                    : 'All Gemini models are rate-limited';
            return { success: false, code: 'RATE_LIMITED', error: `${why} — try again tomorrow.` };
        }

        let lastError = null;
        let authFailures = 0;
        const keyRateHits = {};

        outer:
        for (const key of usableKeys) {
            const ai = new GoogleGenAI({ apiKey: key });
            for (const model of chain) {
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        const response = await ai.models.generateContent({
                            model,
                            contents: [
                                { inlineData: { data: buffer.toString('base64'), mimeType } },
                                getPromptForLang(lang)
                            ]
                        });
                        const transcript = (response.text ?? '').trim();
                        if (!transcript) {
                            return { success: false, code: 'NO_SPEECH', error: 'No speech detected.' };
                        }

                        // Clear model and key cooldowns on success
                        const cd = { ...(loadConfig().modelCooldowns || {}) };
                        if (cd[model]) { delete cd[model]; saveConfig({ modelCooldowns: cd }); }
                        const kd = { ...(loadConfig().keyCooldowns || {}) };
                        const ck = cooldownKey(key);
                        if (kd[ck]) { delete kd[ck]; saveConfig({ keyCooldowns: kd }); }

                        if (model !== preferred) {
                            saveConfig({ geminiModel: model });
                            onFallback(model);
                        }

                        const del = onDeliver(transcript);
                        return { success: true, text: transcript, model, typed: del.typed === true };
                    } catch (error) {
                        lastError = error;
                        logger.warn(`[gemini] API attempt failed (${model}): ${sanitizeErrorMessage(error)}`);
                        if (isAuthError(error)) {
                            authFailures++;
                            continue outer;
                        }
                        if (isRateLimitError(error)) {
                            const cd = { ...(loadConfig().modelCooldowns || {}) };
                            cd[model] = Date.now() + GEMINI_COOLDOWN_MS;
                            saveConfig({ modelCooldowns: cd });

                            const rateKey = cooldownKey(key);
                            keyRateHits[rateKey] = (keyRateHits[rateKey] || 0) + 1;
                            if (keyRateHits[rateKey] >= 2) {
                                const kd = { ...(loadConfig().keyCooldowns || {}) };
                                kd[cooldownKey(key)] = Date.now() + GEMINI_COOLDOWN_MS;
                                saveConfig({ keyCooldowns: kd });
                                continue outer;
                            }
                            break;
                        }
                        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 400));
                    }
                }
            }
        }

        if (authFailures >= usableKeys.length) {
            return { success: false, code: 'AUTH_ERROR', error: 'Gemini rejected the API key. Check your key in Settings.' };
        }
        return { success: false, code: 'NETWORK_ERROR', error: sanitizeErrorMessage(lastError) };
    };
}

module.exports = {
    GEMINI_MODEL_LADDER,
    GEMINI_COOLDOWN_MS,
    createGeminiTranscriber
};
