// src/renderer/recording.js
// Audio recording lifecycle, VAD frame evaluation, IPC transcription dispatch, and Transcribe Again retry logic.

window.VTC = window.VTC || {};

(function () {
    let isRecording = false;
    let isStartingRecording = false;
    let recordingSessionId = 0;
    let mediaRecorder = null;
    let audioChunks = [];
    let cancelPending = false;
    let lastAudio = null;

    let audioCtx = null;
    let analyser = null;
    let source = null;
    let vadTimer = null;
    let vadBuffer = null;

    // VAD & silence auto-stop state
    let hasSpoken = false;
    let speechFramesCount = 0;
    let silenceStartTime = null;
    let recordStartTime = 0;
    let noiseFloor = null;
    let silenceAccumMs = 0;
    let lastFrameTs = 0;
    let vadDeadMicLogged = false;
    let vadMin = 0, vadMax = 0, vadSum = 0, vadCount = 0;
    let vadBlockEntries = 0, vadSpeechFrames = 0, vadSilenceFrames = 0, vadErrors = 0;
    const NOISE_MARGIN = 8;
    const MIN_VAD_THRESHOLD = 6;
    const SPEECH_ARM_FRAMES = 3;

    // DOM Elements
    const micBtn = document.getElementById('mic-button');
    const micContainer = document.getElementById('mic-container');
    const statusBadge = document.getElementById('status-badge');
    const statusText = document.getElementById('status-text');
    const retryBtn = document.getElementById('retry-btn');
    const retranscribeBtn = document.getElementById('retranscribe-btn');
    const cancelBtn = document.getElementById('cancel-btn');

    function log(msg) {
        try { window.api?.rendererLog(String(msg)); } catch (e) {}
    }

    function setStatus(mode, text) {
        const trText = window.VTC?.i18n?.tr(text) || text;
        if (statusText && statusText.textContent !== trText) {
            statusText.textContent = trText;
        }
        if (statusBadge) {
            statusBadge.classList.remove('busy', 'done', 'dim', 'err');
            if (mode) statusBadge.classList.add(mode);
            statusBadge.classList.add('visible');
        }
    }

    function hideStatus() {
        if (statusBadge) statusBadge.classList.remove('visible');
    }

    let fallbackStatusTimer = null;

    // Degraded-mode feedback after a Gemini fallback: persists until the next
    // successful transcription or an 8s timeout, whichever comes first.
    function setFallbackStatus(msg) {
        setStatus('busy', msg);
        if (fallbackStatusTimer) clearTimeout(fallbackStatusTimer);
        fallbackStatusTimer = setTimeout(() => {
            fallbackStatusTimer = null;
            if (!isRecording && !isStartingRecording) hideStatus();
        }, 8000);
    }

    function clearFallbackStatus() {
        if (fallbackStatusTimer) {
            clearTimeout(fallbackStatusTimer);
            fallbackStatusTimer = null;
        }
    }

    function isRetryableFailure(code) {
        return code && code !== 'NO_SPEECH' && code !== 'MIC_TOO_QUIET';
    }

    function showRetryButton() {
        if (!retryBtn || !lastAudio) return;
        document.body.classList.add('has-retry');
        window.VTC?.interaction?.refreshMouseIgnore();
    }

    function hideRetryButton() {
        if (!retryBtn) return;
        document.body.classList.remove('has-retry');
        window.VTC?.interaction?.refreshMouseIgnore();
    }

    function refreshRetranscribeBtn() {
        if (!retranscribeBtn) return;
        const has = !!(lastAudio && !isRecording && !isStartingRecording);
        retranscribeBtn.style.display = has ? 'flex' : 'none';
        if (has) window.VTC?.interaction?.refreshMouseIgnore();
    }

    function processVadFrame(dataArray) {
        const calculateSpeechVolume = window.VTC?.vad?.calculateSpeechVolume;
        if (!calculateSpeechVolume) return;

        const currentVol = calculateSpeechVolume(dataArray);
        const smoothed = (window.VTC.vad.smoothedSpeechVolume || 0) * 0.65 + currentVol * 0.35;
        window.VTC.vad.smoothedSpeechVolume = smoothed;

        vadMin = vadCount === 0 ? smoothed : Math.min(vadMin, smoothed);
        vadMax = Math.max(vadMax, smoothed);
        vadSum += smoothed;
        vadCount++;

        const currentSttConfig = window.VTC?.settings?.currentSttConfig;
        const silenceThresholdSlider = document.getElementById('silence-threshold-slider');
        const silenceThresh = (currentSttConfig && typeof currentSttConfig.silenceThreshold === 'number')
            ? currentSttConfig.silenceThreshold
            : (parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12);

        const settingsModal = document.getElementById('settings-modal');
        if (settingsModal && settingsModal.classList.contains('active')) {
            window.VTC?.vad?.updateMeterUI(smoothed, silenceThresh);
        }

        if (currentSttConfig && currentSttConfig.autoStopEnabled) {
            vadBlockEntries++;
            if (vadBlockEntries === 1) log(`[render] VAD block entered | autoStop=true`);
            try {
                if (noiseFloor === null) {
                    noiseFloor = Math.max(4, smoothed);
                } else if (smoothed < noiseFloor) {
                    noiseFloor = noiseFloor * 0.6 + smoothed * 0.4;
                }
                const effectiveThresh = Math.max(MIN_VAD_THRESHOLD, Math.min(silenceThresh, noiseFloor + NOISE_MARGIN));

                const nowTs = performance.now();
                const frameDt = lastFrameTs ? Math.min(200, nowTs - lastFrameTs) : 16;
                lastFrameTs = nowTs;

                if (smoothed > effectiveThresh) {
                    vadSpeechFrames++;
                    speechFramesCount++;
                    if (speechFramesCount >= SPEECH_ARM_FRAMES) hasSpoken = true;
                    silenceAccumMs = 0;
                    if (silenceStartTime !== null) {
                        silenceStartTime = null;
                        setStatus('', 'REC');
                    }
                } else {
                    vadSilenceFrames++;
                    speechFramesCount = 0;
                    if (!hasSpoken && Date.now() - recordStartTime > 8000 && !vadDeadMicLogged) {
                        vadDeadMicLogged = true;
                        log(`[render] VAD watchdog: no speech armed after 8s (smoothed=${smoothed.toFixed(1)}, thresh=${silenceThresh}, ctx=${audioCtx ? audioCtx.state : 'none'})`);
                    }
                    if (hasSpoken && Date.now() - recordStartTime >= 2000) {
                        if (silenceStartTime === null) silenceStartTime = Date.now();
                        silenceAccumMs += frameDt;
                        const maxSec = currentSttConfig.autoStopSeconds || 3.5;
                        if (silenceAccumMs >= maxSec * 1000) {
                            silenceStartTime = null;
                            hasSpoken = false;
                            stopRecording();
                            return;
                        } else if (silenceAccumMs > 300) {
                            const remaining = Math.max(0.1, maxSec - silenceAccumMs / 1000).toFixed(1);
                            setStatus('busy', `PAUSE (${remaining}s)`);
                        }
                    }
                }
            } catch (vadErr) {
                vadErrors++;
                if (vadErrors <= 3) log(`[render] VAD exception: ${String(vadErr && vadErr.stack ? vadErr.stack : vadErr).slice(0, 300)}`);
            }
        }
    }

    function stopVadSampling() {
        if (vadTimer) {
            clearInterval(vadTimer);
            vadTimer = null;
        }
        vadBuffer = null;
    }

    function startVadSampling() {
        stopVadSampling();
        if (!analyser) return;
        vadBuffer = new Uint8Array(analyser.frequencyBinCount);
        vadTimer = setInterval(() => {
            if (!isRecording || !analyser) return;
            if (vadBuffer.length !== analyser.frequencyBinCount) {
                vadBuffer = new Uint8Array(analyser.frequencyBinCount);
            }
            analyser.getByteFrequencyData(vadBuffer);
            processVadFrame(vadBuffer);
        }, 40);
    }

    async function startRecording() {
        if (isRecording || isStartingRecording || (micBtn && micBtn.classList.contains('transcribing'))) return;
        isStartingRecording = true;
        const sessionId = ++recordingSessionId;
        lastAudio = null;
        hideRetryButton();
        refreshRetranscribeBtn();
        let stream = null;
        const t = window.VTC?.i18n?.t || ((k) => k);

        try {
            window.VTC?.vad?.stopSettingsMicPreview();
            window.api?.widgetRaise();
            setStatus('busy', 'STARTING');
            const sttConfig = await window.api?.getSttConfig();
            if (window.VTC?.settings) window.VTC.settings.currentSttConfig = sttConfig;
            log(`[render] record start | autoStop=${!!sttConfig?.autoStopEnabled} (${sttConfig?.autoStopSeconds}s) | threshold=${sttConfig?.silenceThreshold} | engine=${sttConfig?.sttEngine}`);
            
            hasSpoken = false;
            silenceStartTime = null;
            noiseFloor = null;
            silenceAccumMs = 0;
            lastFrameTs = 0;
            vadDeadMicLogged = false;
            vadMin = 0; vadMax = 0; vadSum = 0; vadCount = 0;
            vadBlockEntries = 0; vadSpeechFrames = 0; vadSilenceFrames = 0; vadErrors = 0;

            if (sttConfig?.sttEngine === 'gemini') {
                const status = await window.api?.getApiKeyStatus();
                if (!status?.hasKey) {
                    setStatus('err', 'NO API KEY');
                    setTimeout(hideStatus, 2500);
                    window.VTC?.settings?.openSettings();
                    return;
                }
            } else {
                if (!sttConfig?.modelAvailable) {
                    setStatus('err', 'MODEL UNAVAILABLE');
                    setTimeout(hideStatus, 2500);
                    window.VTC?.settings?.openSettings();
                    return;
                }
                if (!sttConfig?.isDownloaded) {
                    setStatus('err', 'MODEL NOT DOWNLOADED');
                    setTimeout(hideStatus, 2500);
                    window.VTC?.settings?.openSettings();
                    return;
                }
            }

            stream = await window.VTC?.audio?.getMicStream();

            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') {
                try { await audioCtx.resume(); } catch (error) {}
            }
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 64;
            source = audioCtx.createMediaStreamSource(stream);
            source.connect(analyser);

            const mimeType = window.VTC?.audio?.getRecorderMimeType();
            mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            audioChunks = [];
            cancelPending = false;

            mediaRecorder.onerror = () => {
                if (sessionId !== recordingSessionId) return;
                cancelPending = true;
                isRecording = false;
                stopVadSampling();
                window.VTC?.visualizer?.stopVisualizer();
                isStartingRecording = false;
                if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                    try { mediaRecorder.stop(); } catch (error) {}
                }
                if (stream) stream.getTracks().forEach(track => track.stop());
                if (audioCtx) {
                    try { audioCtx.close(); } catch (error) {}
                    audioCtx = null;
                }
                mediaRecorder = null;
                analyser = null;
                source = null;
                document.body.classList.remove('is-recording');
                if (micBtn) micBtn.classList.remove('recording', 'transcribing');
                if (micContainer) micContainer.classList.remove('recording', 'transcribing');
                refreshRetranscribeBtn();
                window.VTC?.interaction?.refreshMouseIgnore();
                setStatus('err', 'RECORDING FAILED');
            };
            mediaRecorder.ondataavailable = event => {
                if (sessionId === recordingSessionId && event.data.size > 0) audioChunks.push(event.data);
            };

            mediaRecorder.onstop = async () => {
                window.VTC?.audio?.playBeep(523, 0.1);
                stream.getTracks().forEach(track => track.stop());
                if (audioCtx) {
                    try { await audioCtx.close(); } catch (error) {}
                    audioCtx = null;
                }

                const chunks = audioChunks;
                audioChunks = [];
                if (cancelPending || sessionId !== recordingSessionId) {
                    cancelPending = false;
                    isStartingRecording = false;
                    return;
                }

                try {
                    const audioBlob = new Blob(chunks, { type: mimeType || 'audio/webm' });
                    let float32Pcm = null;
                    if (sttConfig?.sttEngine === 'local') {
                        float32Pcm = await window.VTC?.audio?.audioBlobTo16kHzFloat32(audioBlob);
                    }
                    lastAudio = {
                        blob: audioBlob,
                        pcm: float32Pcm,
                        mimeType: mimeType || 'audio/webm',
                        engine: sttConfig?.sttEngine,
                        sampleRate: 16000
                    };

                    let result;
                    const uiLang = window.VTC?.i18n?.uiLang || 'en';
                    if (sttConfig?.sttEngine === 'local') {
                        let sumSq = 0;
                        for (let i = 0; i < float32Pcm.length; i++) sumSq += float32Pcm[i] * float32Pcm[i];
                        const rms = float32Pcm.length ? Math.sqrt(sumSq / float32Pcm.length) : 0;
                        if (rms < 0.0004) {
                            lastAudio = null;
                            isStartingRecording = false;
                            if (micBtn) micBtn.classList.remove('transcribing');
                            if (micContainer) micContainer.classList.remove('transcribing');
                            refreshRetranscribeBtn();
                            setStatus('err', 'MIC TOO QUIET');
                            setTimeout(hideStatus, 3500);
                            return;
                        }
                        result = await window.api?.transcribeAudio({
                            engine: 'local',
                            modelKey: sttConfig.localModelKey,
                            pcm: float32Pcm.buffer,
                            sampleRate: 16000,
                            uiLanguage: uiLang
                        });
                    } else {
                        result = await window.api?.transcribeAudio({
                            engine: 'gemini',
                            arrayBuffer: await audioBlob.arrayBuffer(),
                            mimeType: mimeType || 'audio/webm',
                            uiLanguage: uiLang
                        });
                    }

                    if (sessionId !== recordingSessionId) return;
                    if (micBtn) micBtn.classList.remove('transcribing');
                    if (micContainer) micContainer.classList.remove('transcribing');
                    isStartingRecording = false;

                    if (result?.success) {
                        hideRetryButton();
                        refreshRetranscribeBtn();
                        if (micBtn) {
                            micBtn.classList.remove('show-error');
                            micBtn.classList.add('show-check');
                            setTimeout(() => micBtn?.classList.remove('show-check'), 1400);
                        }
                        log(`[render] transcribe OK | engine: ${sttConfig?.sttEngine || '?'}`);
                        clearFallbackStatus();
                        setStatus('done', result.typed ? '✓ TYPED' : '✓ COPIED');
                        setTimeout(hideStatus, 1600);
                        if (!sttConfig || sttConfig.playFinishSound !== false) window.VTC?.audio?.playFinishChime();
                    } else {
                        log(`[render] transcribe FAIL | code: ${result?.code} | err: ${result?.error || ''} | engine: ${sttConfig?.sttEngine || '?'}`);
                        const statusMap = {
                            NO_SPEECH: t('status.NO_SPEECH'),
                            MIC_TOO_QUIET: t('status.MIC_TOO_QUIET'),
                            NO_API_KEY: t('status.NO_API_KEY'),
                            MODEL_UNAVAILABLE: t('status.MODEL_UNAVAILABLE'),
                            MODEL_NOT_DOWNLOADED: t('status.MODEL_NOT_DOWNLOADED'),
                            RATE_LIMIT: t('status.RATE_LIMIT'),
                            RATE_LIMITED: t('status.RATE_LIMIT'),
                            AUTH_ERROR: t('status.AUTH_ERROR')
                        };
                        const statusTextStr = statusMap[result?.code] || t('status.ERROR');
                        setStatus('err', statusTextStr);
                        window.VTC?.audio?.triggerErrorState();
                        if (isRetryableFailure(result?.code)) {
                            showRetryButton();
                            setTimeout(hideStatus, 5000);
                        } else {
                            lastAudio = null;
                            setTimeout(hideStatus, 3500);
                        }
                        refreshRetranscribeBtn();
                    }
                } catch (error) {
                    if (sessionId !== recordingSessionId) return;
                    isStartingRecording = false;
                    if (micBtn) micBtn.classList.remove('transcribing');
                    if (micContainer) micContainer.classList.remove('transcribing');
                    setStatus('err', t('status.ERROR'));
                    window.VTC?.audio?.triggerErrorState();
                    if (lastAudio) showRetryButton();
                    refreshRetranscribeBtn();
                    setTimeout(hideStatus, 4000);
                }
            };

            mediaRecorder.start();
            isStartingRecording = false;
            isRecording = true;
            startVadSampling();
            window.VTC?.visualizer?.startVisualizer();
            refreshRetranscribeBtn();
            recordStartTime = Date.now();
            document.body.classList.add('is-recording');

            if (micBtn) {
                micBtn.classList.add('pop');
                setTimeout(() => micBtn.classList.remove('pop'), 520);
                micBtn.classList.add('recording');
            }
            if (micContainer) micContainer.classList.add('recording');
            setStatus('', 'REC');

        } catch (err) {
            if (stream) stream.getTracks().forEach(track => track.stop());
            if (audioCtx) {
                try { audioCtx.close(); } catch (error) {}
                audioCtx = null;
            }
            console.error('Microphone error:', err);
            setStatus('err', 'MIC UNAVAILABLE');
            setTimeout(hideStatus, 3000);
        } finally {
            isStartingRecording = false;
        }
    }

    function stopRecordingCore(cancel) {
        if (!isRecording) return;
        cancelPending = cancel;
        const wasArmed = hasSpoken;
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        isRecording = false;
        stopVadSampling();
        window.VTC?.visualizer?.stopVisualizer();
        refreshRetranscribeBtn();
        document.body.classList.remove('is-recording');
        window.VTC.vad.smoothedSpeechVolume = 0;
        speechFramesCount = 0;
        silenceStartTime = null;
        hasSpoken = false;
        noiseFloor = null;
        silenceAccumMs = 0;
        lastFrameTs = 0;
        vadDeadMicLogged = false;

        const currentSttConfig = window.VTC?.settings?.currentSttConfig;
        if (vadCount > 0 && !cancel) {
            const avg = (vadSum / vadCount).toFixed(1);
            const eff = currentSttConfig && typeof currentSttConfig.silenceThreshold === 'number'
                ? Math.max(6, Math.min(currentSttConfig.silenceThreshold, (noiseFloor === null ? 0 : noiseFloor) + 8))
                : '?';
            log(`[render] VAD summary | ${((Date.now() - recordStartTime) / 1000).toFixed(1)}s | smoothed min=${vadMin.toFixed(1)} max=${vadMax.toFixed(1)} avg=${avg} | effThresh≈${typeof eff === 'number' ? eff.toFixed(1) : eff} | armed=${wasArmed} | autoStopCfg=${!!(currentSttConfig && currentSttConfig.autoStopEnabled)} | ctx=${audioCtx ? audioCtx.state : 'closed'}`);
        }

        window.VTC?.visualizer?.resetVisualizer();

        if (micBtn) {
            micBtn.classList.remove('recording');
            micBtn.classList.add('burst');
            setTimeout(() => micBtn.classList.remove('burst'), 560);
        }
        if (micContainer) {
            micContainer.classList.remove('recording');
            micContainer.classList.remove('finish');
            void micContainer.offsetWidth;
            micContainer.classList.add('finish');
        }

        if (cancel) {
            setStatus('dim', 'CANCELLED');
            setTimeout(() => { if (!isRecording) hideStatus(); }, 1400);
        } else {
            if (micBtn) micBtn.classList.add('transcribing');
            if (micContainer) micContainer.classList.add('transcribing');
            setStatus('busy', 'TRANSCRIBING');
            window.VTC?.visualizer?.startVisualizer();
        }
    }

    function stopRecording() {
        stopRecordingCore(false);
    }

    function cancelRecording() {
        audioChunks = [];
        lastAudio = null;
        hideRetryButton();
        refreshRetranscribeBtn();
        stopRecordingCore(true);
    }

    async function retranscribeLast() {
        if (!lastAudio || isRecording || isStartingRecording) return;
        hideRetryButton();
        const audio = lastAudio;
        if (micBtn) micBtn.classList.add('transcribing');
        if (micContainer) micContainer.classList.add('transcribing');
        setStatus('busy', 'TRANSCRIBING');
        window.VTC?.visualizer?.startVisualizer();
        const t = window.VTC?.i18n?.t || ((k) => k);

        let result;
        try {
            const cfg = await window.api?.getSttConfig();
            if (window.VTC?.settings) window.VTC.settings.currentSttConfig = cfg;
            const uiLang = window.VTC?.i18n?.uiLang || 'en';
            if (cfg?.sttEngine === 'local') {
                if (!audio.pcm && audio.blob) {
                    audio.pcm = await window.VTC?.audio?.audioBlobTo16kHzFloat32(audio.blob);
                    lastAudio.pcm = audio.pcm;
                }
                result = await window.api?.transcribeAudio({
                    engine: 'local',
                    modelKey: cfg.localModelKey,
                    pcm: audio.pcm.buffer,
                    sampleRate: 16000,
                    uiLanguage: uiLang
                });
            } else {
                result = await window.api?.transcribeAudio({
                    engine: 'gemini',
                    arrayBuffer: await audio.blob.arrayBuffer(),
                    mimeType: audio.mimeType,
                    uiLanguage: uiLang
                });
            }
        } catch (error) {
            result = { success: false, code: 'TRANSCRIPTION_ERROR', error: String(error) };
        }

        if (micBtn) micBtn.classList.remove('transcribing');
        if (micContainer) micContainer.classList.remove('transcribing');

        if (result && result.success) {
            if (micBtn) {
                micBtn.classList.remove('show-error');
                micBtn.classList.add('show-check');
                setTimeout(() => micBtn?.classList.remove('show-check'), 1400);
            }
            clearFallbackStatus();
            log(`[render] transcribe OK | engine: ${window.VTC?.settings?.currentSttConfig?.sttEngine || '?'}`);
            setStatus('done', result?.typed ? '✓ TYPED' : '✓ COPIED');
            setTimeout(hideStatus, 1600);
        } else {
            const code = result?.code || 'ERROR';
            log(`[render] transcribe FAIL(retry) | code: ${code} | err: ${result?.error || ''} | engine: ${window.VTC?.settings?.currentSttConfig?.sttEngine || '?'}`);
            const statusMap = {
                NO_SPEECH: t('status.NO_SPEECH'),
                MIC_TOO_QUIET: t('status.MIC_TOO_QUIET'),
                NO_API_KEY: t('status.NO_API_KEY'),
                MODEL_UNAVAILABLE: t('status.MODEL_UNAVAILABLE'),
                MODEL_NOT_DOWNLOADED: t('status.MODEL_NOT_DOWNLOADED'),
                RATE_LIMIT: t('status.RATE_LIMIT'),
                RATE_LIMITED: t('status.RATE_LIMIT'),
                AUTH_ERROR: t('status.AUTH_ERROR')
            };
            setStatus('err', statusMap[code] || t('status.ERROR'));
            window.VTC?.audio?.triggerErrorState();
            if (isRetryableFailure(code)) {
                showRetryButton();
            } else {
                lastAudio = null;
            }
        }
        refreshRetranscribeBtn();
    }

    if (cancelBtn) cancelBtn.addEventListener('click', cancelRecording);
    if (retryBtn) retryBtn.addEventListener('click', () => retranscribeLast());
    if (retranscribeBtn) {
        retranscribeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            retranscribeBtn.style.display = 'none';
            await retranscribeLast();
        });
    }

    window.VTC.recording = {
        startRecording,
        stopRecording,
        cancelRecording,
        retranscribeLast,
        setStatus,
        hideStatus,
        setFallbackStatus,
        clearFallbackStatus,
        showRetryButton,
        hideRetryButton,
        refreshRetranscribeBtn,
        processVadFrame,
        log,
        get isRecording() { return isRecording; },
        get isStartingRecording() { return isStartingRecording; },
        get analyser() { return analyser; },
        get lastAudio() { return lastAudio; }
    };
})();
