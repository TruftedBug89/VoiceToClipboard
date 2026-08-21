// src/renderer/vad.js
// Voice Activity Detection (VAD) mathematics, frequency-weighted RMS, and noise calibration.

window.VTC = window.VTC || {};

(function () {
    const METER_MAX = 120;
    let smoothedSpeechVolume = 0;
    let isCalibrating = false;

    const noiseMeterBar = document.getElementById('noise-meter-bar');
    const noiseMeterWrap = document.getElementById('noise-meter-wrap');
    const noiseThresholdMarker = document.getElementById('noise-threshold-marker');
    const noiseMeterStatus = document.getElementById('noise-meter-status');
    const silenceThresholdSlider = document.getElementById('silence-threshold-slider');
    const thresholdValueDisplay = document.getElementById('threshold-value-display');
    const autoCalibrateBtn = document.getElementById('auto-calibrate-btn');
    const resetThresholdBtn = document.getElementById('reset-threshold-btn');
    const calibrateDurationSelect = document.getElementById('calibrate-duration-select');
    const calibrateFeedback = document.getElementById('calibrate-feedback');

    let settingsPreviewStream = null;
    let settingsPreviewAudioCtx = null;
    let settingsPreviewAnalyser = null;
    let settingsMeterFrameId = null;
    let settingsPreviewStarting = false;

    /**
     * Frequency-weighted RMS volume focused on vocal speech bands (~150Hz to 8kHz).
     * @param {Uint8Array} dataArray
     * @returns {number}
     */
    function calculateSpeechVolume(dataArray) {
        let sum = 0;
        let count = 0;
        const startBin = 2; // ~150 Hz
        const endBin = Math.min(dataArray.length, 24); // ~8 kHz
        for (let i = startBin; i < endBin; i++) {
            const val = dataArray[i];
            sum += val * val;
            count++;
        }
        if (count === 0) return 0;
        return Math.sqrt(sum / count);
    }

    /**
     * Computes the p-th percentile from a sorted array of numbers.
     * @param {number[]} sorted
     * @param {number} p (0..100)
     * @returns {number}
     */
    function percentile(sorted, p) {
        if (!sorted.length) return 0;
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
        return sorted[idx];
    }

    function updateMeterUI(vol, threshold) {
        if (!noiseMeterBar || !noiseThresholdMarker || !noiseMeterStatus) return;
        const t = window.VTC?.i18n?.t || ((k) => k);
        const pct = Math.min(100, Math.max(0, Math.round((vol / METER_MAX) * 100)));
        const threshPct = Math.min(100, Math.max(0, Math.round((threshold / METER_MAX) * 100)));

        noiseMeterBar.style.width = `${pct}%`;
        noiseThresholdMarker.style.left = `${threshPct}%`;

        const ratio = threshold > 0 ? vol / threshold : 0;
        if (ratio > 1.15) {
            noiseMeterStatus.textContent = t('meter.speechVal', { v: Math.round(vol) });
            noiseMeterStatus.style.color = '#ef4444';
        } else if (ratio > 0.85) {
            noiseMeterStatus.textContent = t('meter.nearThreshold', { v: Math.round(vol) });
            noiseMeterStatus.style.color = '#f59e0b';
        } else {
            noiseMeterStatus.textContent = t('meter.silentVal', { v: Math.round(vol) });
            noiseMeterStatus.style.color = '#10b981';
        }
    }

    function gapWarn(noiseP50, noiseP90, newThresh) {
        const t = window.VTC?.i18n?.t || ((k) => k);
        const mid = Math.round(noiseP50);
        const peak = Math.round(noiseP90);
        if (peak < 12) {
            return t('autostop.calibrate.quiet', { mid, newThresh });
        }
        if (peak > 70) {
            return t('autostop.calibrate.loud', { mid, newThresh });
        }
        return t('autostop.calibrate.normal', { mid, peak, newThresh });
    }

    async function startSettingsMicPreview() {
        if (window.VTC?.recording?.isRecording || settingsPreviewStream || settingsPreviewStarting) return;
        settingsPreviewStarting = true;
        try {
            settingsPreviewStream = await window.VTC.audio.getMicStream();
            settingsPreviewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (settingsPreviewAudioCtx.state === 'suspended') {
                try { await settingsPreviewAudioCtx.resume(); } catch (e) {}
            }
            settingsPreviewAnalyser = settingsPreviewAudioCtx.createAnalyser();
            settingsPreviewAnalyser.fftSize = 64;
            const previewSource = settingsPreviewAudioCtx.createMediaStreamSource(settingsPreviewStream);
            previewSource.connect(settingsPreviewAnalyser);
            if (noiseMeterWrap) noiseMeterWrap.style.display = 'block';

            function renderSettingsMeter() {
                const isSettingsOpen = document.getElementById('settings-modal')?.classList.contains('active');
                if (!settingsPreviewAnalyser || window.VTC?.recording?.isRecording || !isSettingsOpen) {
                    stopSettingsMicPreview();
                    return;
                }
                const bufferLen = settingsPreviewAnalyser.frequencyBinCount;
                const dataArr = new Uint8Array(bufferLen);
                settingsPreviewAnalyser.getByteFrequencyData(dataArr);

                const rawVol = calculateSpeechVolume(dataArr);
                smoothedSpeechVolume = smoothedSpeechVolume * 0.65 + rawVol * 0.35;

                const threshold = parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12;
                updateMeterUI(smoothedSpeechVolume, threshold);

                settingsMeterFrameId = requestAnimationFrame(renderSettingsMeter);
            }

            renderSettingsMeter();
        } catch (e) {
            console.warn('Settings mic preview unavailable:', e);
        } finally {
            settingsPreviewStarting = false;
        }
    }

    function stopSettingsMicPreview() {
        if (settingsMeterFrameId) {
            cancelAnimationFrame(settingsMeterFrameId);
            settingsMeterFrameId = null;
        }
        if (settingsPreviewStream) {
            settingsPreviewStream.getTracks().forEach(t => t.stop());
            settingsPreviewStream = null;
        }
        if (settingsPreviewAudioCtx) {
            try { settingsPreviewAudioCtx.close(); } catch (e) {}
            settingsPreviewAudioCtx = null;
        }
        settingsPreviewAnalyser = null;
        if (noiseMeterWrap) noiseMeterWrap.style.display = 'none';
    }

    async function autoCalibrateNoiseFloor() {
        if (isCalibrating) return;
        isCalibrating = true;
        const t = window.VTC?.i18n?.t || ((k) => k);
        const origText = autoCalibrateBtn.textContent;
        let tempStream = null;
        let tempCtx = null;
        let countdown = null;
        let sampleLoop = null;
        let ownsStream = false;
        let completed = false;
        const cleanup = () => {
            if (countdown) clearInterval(countdown);
            if (sampleLoop) clearInterval(sampleLoop);
            if (tempCtx) {
                try { tempCtx.close(); } catch (e) {}
                tempCtx = null;
            }
            if (ownsStream && tempStream) tempStream.getTracks().forEach(t => t.stop());
        };
        const resetUi = () => {
            autoCalibrateBtn.textContent = origText;
            autoCalibrateBtn.disabled = false;
            isCalibrating = false;
            if (calibrateFeedback) calibrateFeedback.style.color = '';
            stopSettingsMicPreview();
            startSettingsMicPreview();
        };

        autoCalibrateBtn.disabled = true;
        if (calibrateFeedback) { calibrateFeedback.style.color = ''; calibrateFeedback.textContent = ''; }
        if (noiseMeterWrap) noiseMeterWrap.style.display = 'block';

        try {
            tempStream = settingsPreviewStream || await window.VTC.audio.getMicStream().catch(() => null);
            ownsStream = !settingsPreviewStream;
            if (!tempStream) {
                if (calibrateFeedback) calibrateFeedback.textContent = t('autostop.calibrate.noAccess');
                return;
            }

            tempCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (tempCtx.state === 'suspended') {
                try { await tempCtx.resume(); } catch (e) {}
            }
            const tempAnalyser = tempCtx.createAnalyser();
            tempAnalyser.fftSize = 64;
            const tempSrc = tempCtx.createMediaStreamSource(tempStream);
            tempSrc.connect(tempAnalyser);

            const durationSec = Math.min(10, Math.max(3, parseInt(calibrateDurationSelect?.value || '5', 10) || 5));
            const noiseSamples = [];
            let sec = durationSec;
            autoCalibrateBtn.textContent = t('autostop.calibrate.listening', { s: sec });
            if (calibrateFeedback) calibrateFeedback.textContent = t('autostop.calibrate.dontTalk', { s: durationSec });
            countdown = setInterval(() => {
                sec--;
                if (sec > 0) autoCalibrateBtn.textContent = t('autostop.calibrate.listening', { s: sec });
            }, 1000);
            sampleLoop = setInterval(() => {
                const dataArr = new Uint8Array(tempAnalyser.frequencyBinCount);
                tempAnalyser.getByteFrequencyData(dataArr);
                const vol = calculateSpeechVolume(dataArr);
                smoothedSpeechVolume = smoothedSpeechVolume * 0.65 + vol * 0.35;
                noiseSamples.push(vol);
                const threshold = parseInt(silenceThresholdSlider ? silenceThresholdSlider.value : 12) || 12;
                updateMeterUI(smoothedSpeechVolume, threshold);
            }, 50);

            await new Promise(resolve => setTimeout(resolve, durationSec * 1000));
            cleanup();
            const sorted = [...noiseSamples].sort((a, b) => a - b);
            const noiseP50 = percentile(sorted, 50);
            const noiseP90 = percentile(sorted, 90);
            let newThresh = Math.round(noiseP90 * 1.25 + 6);
            newThresh = Math.min(100, Math.max(2, newThresh));

            if (!noiseSamples.length || Math.max(...noiseSamples) < 1) {
                if (calibrateFeedback) {
                    calibrateFeedback.style.color = '#ef4444';
                    calibrateFeedback.textContent = t('autostop.calibrate.noSound');
                }
                return;
            }

            if (silenceThresholdSlider) silenceThresholdSlider.value = newThresh;
            if (thresholdValueDisplay) thresholdValueDisplay.textContent = newThresh;
            if (window.VTC?.settings?.currentSttConfig) window.VTC.settings.currentSttConfig.silenceThreshold = newThresh;
            window.VTC?.settings?.autoSaveSettings?.();
            updateMeterUI(noiseP90, newThresh);
            if (calibrateFeedback) {
                calibrateFeedback.style.color = '#10b981';
                calibrateFeedback.textContent = gapWarn(noiseP50, noiseP90, newThresh);
            }

            completed = true;
            autoCalibrateBtn.textContent = t('autostop.calibrate.done', { n: newThresh });
            setTimeout(resetUi, 2500);
        } catch (error) {
            if (calibrateFeedback) {
                calibrateFeedback.style.color = '#ef4444';
                calibrateFeedback.textContent = t('autostop.calibrate.failed');
            }
        } finally {
            cleanup();
            if (!completed) resetUi();
        }
    }

    if (silenceThresholdSlider) {
        silenceThresholdSlider.addEventListener('input', () => {
            const val = parseInt(silenceThresholdSlider.value) || 12;
            if (thresholdValueDisplay) thresholdValueDisplay.textContent = val;
            if (window.VTC?.settings?.currentSttConfig) window.VTC.settings.currentSttConfig.silenceThreshold = val;
            updateMeterUI(smoothedSpeechVolume, val);
            window.VTC?.settings?.autoSaveSettings?.();
        });
    }

    if (resetThresholdBtn) {
        resetThresholdBtn.addEventListener('click', () => {
            const t = window.VTC?.i18n?.t || ((k) => k);
            const val = 12;
            if (silenceThresholdSlider) silenceThresholdSlider.value = val;
            if (thresholdValueDisplay) thresholdValueDisplay.textContent = val;
            if (window.VTC?.settings?.currentSttConfig) window.VTC.settings.currentSttConfig.silenceThreshold = val;
            if (calibrateFeedback) calibrateFeedback.textContent = t('autostop.thresholdReset');
            updateMeterUI(smoothedSpeechVolume, val);
            window.VTC?.settings?.autoSaveSettings?.();
        });
    }

    if (autoCalibrateBtn) {
        autoCalibrateBtn.addEventListener('click', autoCalibrateNoiseFloor);
    }

    window.VTC.vad = {
        METER_MAX,
        calculateSpeechVolume,
        percentile,
        gapWarn,
        updateMeterUI,
        startSettingsMicPreview,
        stopSettingsMicPreview,
        autoCalibrateNoiseFloor,
        get smoothedSpeechVolume() { return smoothedSpeechVolume; },
        set smoothedSpeechVolume(v) { smoothedSpeechVolume = v; },
        get isCalibrating() { return isCalibrating; }
    };
})();
