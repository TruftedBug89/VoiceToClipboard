// src/renderer/audio.js
// Web Audio synthesis, microphone stream capture, PCM Float32 resampling, and device enumeration.

window.VTC = window.VTC || {};

(function () {
    let micDeviceId = '';
    let micDeviceLabel = '';

    const micBtn = document.getElementById('mic-button');
    const micSelect = document.getElementById('mic-select');
    const micTestBtn = document.getElementById('mic-test-btn');
    const micTestMeterWrap = document.getElementById('mic-test-meter-wrap');
    const micTestMeterBar = document.getElementById('mic-test-meter-bar');
    const micTestMeterStatus = document.getElementById('mic-test-meter-status');

    let isTestingMic = false;
    let testMicStream = null;
    let testMicAudioCtx = null;
    let testMicAnalyser = null;
    let testMicFrameId = null;

    function playBeep(freq = 880, duration = 0.08) {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.onended = () => { try { ctx.close(); } catch (e) {} };
            osc.start();
            osc.stop(ctx.currentTime + duration);
        } catch (e) {}
    }

    function playFinishChime() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const now = ctx.currentTime;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.09, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
            gain.connect(ctx.destination);
            const tones = [659.25, 880.0];
            tones.forEach((freq, idx) => {
                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = freq;
                osc.connect(gain);
                osc.start(now + idx * 0.12);
                osc.stop(now + 0.6 + idx * 0.12);
            });
            setTimeout(() => { try { ctx.close(); } catch (e) {} }, 900);
        } catch (e) {}
    }

    function playErrorTone() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const now = ctx.currentTime;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.12, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
            gain.connect(ctx.destination);
            const osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(293.66, now);
            osc.frequency.exponentialRampToValueAtTime(220.0, now + 0.35);
            osc.connect(gain);
            osc.start(now);
            osc.stop(now + 0.45);
            setTimeout(() => { try { ctx.close(); } catch (e) {} }, 700);
        } catch (e) {}
    }

    function triggerErrorState() {
        if (micBtn) {
            micBtn.classList.remove('show-check', 'pop', 'burst', 'recording', 'transcribing');
            micBtn.classList.add('show-error');
            setTimeout(() => {
                if (micBtn) micBtn.classList.remove('show-error');
            }, 2200);
        }
        const cfg = window.VTC?.settings?.currentSttConfig;
        if (!cfg || cfg.playFinishSound !== false) {
            playErrorTone();
        }
    }

    async function getMicStream() {
        if (micDeviceId) {
            try {
                return await navigator.mediaDevices.getUserMedia({
                    audio: { deviceId: { exact: micDeviceId } }
                });
            } catch (err) {
                if (err.name === 'OverconstrainedError' || err.name === 'NotFoundError') {
                    console.warn('[render] Selected mic unavailable, falling back to default:', err);
                    return await navigator.mediaDevices.getUserMedia({ audio: true });
                }
                throw err;
            }
        }
        return await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    async function audioBlobTo16kHzFloat32(audioBlob) {
        const arrayBuffer = await audioBlob.arrayBuffer();
        const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
        try {
            const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
            const targetSampleRate = 16000;
            const offlineCtx = new OfflineAudioContext(1, Math.max(1, Math.ceil(audioBuffer.duration * targetSampleRate)), targetSampleRate);
            const sourceNode = offlineCtx.createBufferSource();
            sourceNode.buffer = audioBuffer;
            sourceNode.connect(offlineCtx.destination);
            sourceNode.start(0);

            const resampledBuffer = await offlineCtx.startRendering();
            return resampledBuffer.getChannelData(0);
        } finally {
            try { await tempCtx.close(); } catch (e) {}
        }
    }

    function getRecorderMimeType() {
        const candidates = ['audio/webm;codecs=opus', 'audio/webm'];
        return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
    }

    async function populateMicDevices() {
        if (!micSelect) return;
        const t = window.VTC?.i18n?.t || ((k) => k);
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(d => d.kind === 'audioinput');

            const currentVal = micDeviceId || micSelect.value || '';
            micSelect.replaceChildren();

            const defaultOpt = document.createElement('option');
            defaultOpt.value = '';
            defaultOpt.textContent = t('mic.default');
            micSelect.appendChild(defaultOpt);

            let foundCurrent = false;
            audioInputs.forEach((dev, idx) => {
                const opt = document.createElement('option');
                opt.value = dev.deviceId;
                opt.textContent = dev.label || `Microphone ${idx + 1}`;
                if (dev.deviceId === currentVal) foundCurrent = true;
                micSelect.appendChild(opt);
            });

            if (foundCurrent) {
                micSelect.value = currentVal;
            } else if (currentVal && micDeviceLabel) {
                const unpluggedOpt = document.createElement('option');
                unpluggedOpt.value = currentVal;
                unpluggedOpt.textContent = `${micDeviceLabel} (Disconnected)`;
                micSelect.appendChild(unpluggedOpt);
                micSelect.value = currentVal;
            } else {
                micSelect.value = '';
            }
        } catch (e) {
            console.warn('[render] Failed to enumerate audio devices:', e);
        }
    }

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', () => {
            populateMicDevices();
        });
    }

    if (micSelect) {
        micSelect.addEventListener('change', () => {
            micDeviceId = micSelect.value;
            const selectedOpt = micSelect.options[micSelect.selectedIndex];
            micDeviceLabel = micDeviceId ? (selectedOpt ? selectedOpt.textContent.replace(' (Disconnected)', '') : '') : '';
            window.VTC?.settings?.autoSaveSettings?.();
            if (isTestingMic) {
                stopMicTest();
                startMicTest();
            }
        });
    }

    async function startMicTest() {
        if (isTestingMic || window.VTC?.recording?.isRecording) return;
        const t = window.VTC?.i18n?.t || ((k) => k);
        try {
            testMicStream = await getMicStream();
            testMicAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (testMicAudioCtx.state === 'suspended') {
                try { await testMicAudioCtx.resume(); } catch (e) {}
            }
            testMicAnalyser = testMicAudioCtx.createAnalyser();
            testMicAnalyser.fftSize = 64;
            const src = testMicAudioCtx.createMediaStreamSource(testMicStream);
            src.connect(testMicAnalyser);
            isTestingMic = true;

            if (micTestBtn) micTestBtn.textContent = t('mic.stopTest');
            if (micTestMeterWrap) micTestMeterWrap.style.display = 'block';

            let lastNonZeroAt = performance.now();
            function renderTestMeter() {
                const isSettingsOpen = document.getElementById('settings-modal')?.classList.contains('active');
                if (!isTestingMic || !testMicAnalyser || !isSettingsOpen) {
                    stopMicTest();
                    return;
                }
                const data = new Uint8Array(testMicAnalyser.frequencyBinCount);
                testMicAnalyser.getByteFrequencyData(data);
                const vol = window.VTC?.vad?.calculateSpeechVolume?.(data) || 0;
                const meterMax = window.VTC?.vad?.METER_MAX || 120;
                const pct = Math.min(100, Math.max(0, Math.round((vol / meterMax) * 100)));
                if (micTestMeterBar) micTestMeterBar.style.width = `${pct}%`;
                if (micTestMeterStatus) {
                    if (vol > 0) lastNonZeroAt = performance.now();
                    if (vol > 15) {
                        micTestMeterStatus.textContent = `${t('meter.speech')} ${Math.round(vol)}`;
                        micTestMeterStatus.style.color = '#10b981';
                    } else if (vol === 0 && performance.now() - lastNonZeroAt > 2000) {
                        micTestMeterStatus.textContent = t('mic.noSignal');
                        micTestMeterStatus.style.color = '#ef4444';
                    } else {
                        micTestMeterStatus.textContent = `${t('meter.silent')} ${Math.round(vol)}`;
                        micTestMeterStatus.style.color = 'var(--text-dim)';
                    }
                }
                testMicFrameId = requestAnimationFrame(renderTestMeter);
            }
            renderTestMeter();
        } catch (err) {
            console.warn('[render] Mic test failed:', err);
            stopMicTest();
        }
    }

    function stopMicTest() {
        const t = window.VTC?.i18n?.t || ((k) => k);
        if (testMicFrameId) {
            cancelAnimationFrame(testMicFrameId);
            testMicFrameId = null;
        }
        if (testMicStream) {
            testMicStream.getTracks().forEach(tr => tr.stop());
            testMicStream = null;
        }
        if (testMicAudioCtx) {
            try { testMicAudioCtx.close(); } catch (e) {}
            testMicAudioCtx = null;
        }
        testMicAnalyser = null;
        isTestingMic = false;
        if (micTestBtn) micTestBtn.textContent = t('mic.test');
        if (micTestMeterWrap) micTestMeterWrap.style.display = 'none';
    }

    if (micTestBtn) {
        micTestBtn.addEventListener('click', () => {
            if (isTestingMic) stopMicTest();
            else startMicTest();
        });
    }

    window.VTC.audio = {
        playBeep,
        playFinishChime,
        playErrorTone,
        triggerErrorState,
        getMicStream,
        audioBlobTo16kHzFloat32,
        getRecorderMimeType,
        populateMicDevices,
        startMicTest,
        stopMicTest,
        get micDeviceId() { return micDeviceId; },
        set micDeviceId(v) { micDeviceId = v; },
        get micDeviceLabel() { return micDeviceLabel; },
        set micDeviceLabel(v) { micDeviceLabel = v; },
        get isTestingMic() { return isTestingMic; }
    };
})();
