// src/renderer/visualizer.js
// Audio-reactive circular visualizer canvas supporting 4 distinct themes.

window.VTC = window.VTC || {};

(function () {
    const isSettingsWindow = new URLSearchParams(window.location.search).get('settings') === '1';
    const canvas = document.getElementById('visualizer-canvas');
    const canvasCtx = canvas ? canvas.getContext('2d') : null;

    const smoothValues = new Array(32).fill(0);
    const auroraParticles = Array.from({ length: 24 }, () => ({
        x: (Math.random() - 0.5) * 80,
        y: (Math.random() - 0.5) * 80,
        radius: 2 + Math.random() * 4,
        vx: (Math.random() - 0.5) * 0.4,
        vy: -0.3 - Math.random() * 0.5,
        alpha: 0.2 + Math.random() * 0.6,
        phase: Math.random() * Math.PI * 2
    }));
    const terminalPeaks = new Array(14).fill(0);
    const terminalPeakDecay = new Array(14).fill(0);

    let visualizerStartTime = 0;
    let animationFrameId = null;
    let analyserDataArray = null;
    let vizErrLogged = false;
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function getStyleColors(style) {
        switch (style) {
            case 'ocean':
                return { r: 14, g: 165, b: 233, hex: '#0ea5e9', hover: '#38bdf8' };
            case 'aurora':
                return { r: 168, g: 85, b: 247, hex: '#a855f7', hover: '#c084fc' };
            case 'terminal':
                return { r: 0, g: 255, b: 102, hex: '#00ff66', hover: '#55ff99' };
            case 'crimson':
            default:
                return { r: 255, g: 59, b: 78, hex: '#ff3b4e', hover: '#ff6b7a' };
        }
    }

    function isRecordingNow() {
        return !!window.VTC?.recording?.isRecording;
    }

    function isTranscribingState() {
        return !!document.getElementById('mic-button')?.classList.contains('transcribing');
    }

    function scheduleFrame() {
        if (animationFrameId || document.hidden || reducedMotion) return;
        animationFrameId = setTimeout(() => {
            animationFrameId = null;
            drawVisualizer();
            scheduleFrame();
        }, 33);
    }

    function startVisualizer() {
        if (isSettingsWindow || !canvasCtx) return;
        if (!visualizerStartTime) visualizerStartTime = performance.now();
        drawVisualizer();
        scheduleFrame();
    }

    function stopVisualizer() {
        if (animationFrameId) {
            clearTimeout(animationFrameId);
            animationFrameId = null;
        }
        if (!isSettingsWindow && canvasCtx) drawVisualizer();
    }

    function drawVisualizer() {
        if (isSettingsWindow || !canvasCtx) return;
        try {
            if (!visualizerStartTime) visualizerStartTime = performance.now();
            const rawElapsed = (performance.now() - visualizerStartTime) / 1000;
            // Reduced motion: freeze every oscillation at a calm mid-phase so
            // the ambient frame is static instead of animating.
            const elapsed = reducedMotion ? 1.3 : rawElapsed;

            canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
            const centerX = canvas.width / 2;
            const centerY = canvas.height / 2;

            let dataArray = null;
            let bufferLength = 0;
            const analyser = window.VTC?.recording?.analyser;
            const isRecording = window.VTC?.recording?.isRecording;

            if (analyser && isRecording) {
                bufferLength = analyser.frequencyBinCount;
                if (!analyserDataArray || analyserDataArray.length !== bufferLength) {
                    analyserDataArray = new Uint8Array(bufferLength);
                }
                dataArray = analyserDataArray;
                analyser.getByteFrequencyData(dataArray);
            }

            const isRecordingNow = !!(analyser && isRecording);
            const isTranscribing = !isRecordingNow && isTranscribingState();
            const isActiveNow = isRecordingNow || isTranscribing;
            const currentStyle = window.VTC?.settings?.currentWidgetStyle || 'crimson';
            const col = getStyleColors(currentStyle);

            if (currentStyle === 'ocean') {
                const wavePoints = 44;
                const width = canvas.width;
                const baseLine = centerY + 32;
                const breath = isRecordingNow ? 1 : 0.5 + 0.5 * Math.sin(elapsed * 1.8);

                // Background wave
                canvasCtx.beginPath();
                for (let i = 0; i <= wavePoints; i++) {
                    const x = (i / wavePoints) * width;
                    const ampBack = (isRecordingNow && dataArray && bufferLength > 0)
                        ? (dataArray[Math.min(bufferLength - 1, Math.floor((i / wavePoints) * (bufferLength / 2)))] / 255) * 16
                        : Math.sin(elapsed * 1.5 + i * 0.2) * 3 * breath;
                    const yBack = baseLine + 4 - Math.sin(elapsed * (isTranscribing ? 2.8 : 2) + (i / wavePoints) * Math.PI * 3) * (4 + ampBack + (isTranscribing ? 1.5 : 0));
                    if (i === 0) canvasCtx.moveTo(x, yBack);
                    else canvasCtx.lineTo(x, yBack);
                }
                canvasCtx.lineTo(width, canvas.height);
                canvasCtx.lineTo(0, canvas.height);
                canvasCtx.closePath();
                const backGrad = canvasCtx.createLinearGradient(0, baseLine - 10, 0, canvas.height);
                backGrad.addColorStop(0, `rgba(${col.r}, ${col.g}, ${col.b}, ${isActiveNow ? 0.25 : 0.12})`);
                backGrad.addColorStop(1, 'transparent');
                canvasCtx.fillStyle = backGrad;
                canvasCtx.fill();

                // Foreground crest wave
                canvasCtx.beginPath();
                for (let i = 0; i <= wavePoints; i++) {
                    const x = (i / wavePoints) * width;
                    let amp = 0;
                    if (isRecordingNow && dataArray && bufferLength > 0) {
                        const bin = Math.min(bufferLength - 1, Math.floor((i / wavePoints) * (bufferLength / 2)));
                        amp = (dataArray[bin] / 255) * 26;
                    } else {
                        amp = Math.sin(elapsed * (isTranscribing ? 3.4 : 2.5) + i * 0.35) * (isTranscribing ? 5.5 : 4.5) * breath;
                    }
                    const y = baseLine - Math.sin(elapsed * (isTranscribing ? 3.4 : 3.2) + (i / wavePoints) * Math.PI * 4) * (5 + amp);
                    if (i === 0) canvasCtx.moveTo(x, y);
                    else canvasCtx.lineTo(x, y);
                }
                canvasCtx.lineTo(width, canvas.height);
                canvasCtx.lineTo(0, canvas.height);
                canvasCtx.closePath();

                const grad = canvasCtx.createLinearGradient(0, baseLine - 20, 0, canvas.height);
                const alpha = isActiveNow ? 0.5 : 0.28;
                grad.addColorStop(0, `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha})`);
                grad.addColorStop(1, `rgba(${col.r}, ${col.g}, ${col.b}, 0)`);
                canvasCtx.fillStyle = grad;
                canvasCtx.fill();

                canvasCtx.lineWidth = isActiveNow ? 2.5 : 1.6;
                canvasCtx.strokeStyle = `rgba(${col.r}, ${col.g}, ${col.b}, ${isActiveNow ? 0.95 : 0.6})`;
                canvasCtx.shadowColor = `rgba(${col.r}, ${col.g}, ${col.b}, 0.75)`;
                canvasCtx.shadowBlur = isActiveNow ? 10 : 3;
                canvasCtx.stroke();
                canvasCtx.shadowBlur = 0;

            } else if (currentStyle === 'aurora') {
                const smoothedVol = window.VTC?.vad?.smoothedSpeechVolume || 0;
                const intensity = (isRecordingNow && dataArray) ? (smoothedVol / 100) : (isTranscribing ? 0.5 : 0.3);

                auroraParticles.forEach((p) => {
                    p.y += p.vy * (1 + intensity * 1.5);
                    p.x += Math.sin(elapsed * (isTranscribing ? 1.7 : 1.2) + p.phase) * 0.3;
                    if (p.y < -60 || p.x < -60 || p.x > 60) {
                        p.x = (Math.random() - 0.5) * 80;
                        p.y = 40 + Math.random() * 20;
                    }

                    const px = centerX + p.x;
                    const py = centerY + p.y;
                    const r = Math.max(1, p.radius * (1 + intensity * 0.8));
                    const alpha = Math.min(1, p.alpha * (0.6 + intensity * 0.8));

                    const pGrad = canvasCtx.createRadialGradient(px, py, 0, px, py, r * 2.5);
                    pGrad.addColorStop(0, `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha})`);
                    pGrad.addColorStop(0.5, `rgba(192, 132, 252, ${alpha * 0.5})`);
                    pGrad.addColorStop(1, 'transparent');

                    canvasCtx.fillStyle = pGrad;
                    canvasCtx.beginPath();
                    canvasCtx.arc(px, py, r * 2.5, 0, Math.PI * 2);
                    canvasCtx.fill();
                });

            } else if (currentStyle === 'terminal') {
                const barCount = 14;
                const barWidth = 6;
                const barGap = 3;
                const totalW = barCount * (barWidth + barGap) - barGap;
                const startX = centerX - totalW / 2;
                const blockHeight = 3;
                const blockGap = 1.5;
                const maxBlocks = 12;

                for (let i = 0; i < barCount; i++) {
                    let level = 0;
                    if (isRecordingNow && dataArray && bufferLength > 0) {
                        const bin = Math.min(bufferLength - 1, Math.floor((i / barCount) * (bufferLength / 2)));
                        level = smoothValues[i] = (smoothValues[i] || 0) * 0.7 + (dataArray[bin] / 255) * 0.3;
                    } else {
                        const wave = isTranscribing
                            ? (0.3 + 0.22 * Math.sin(elapsed * 3.2 + i * 0.7) + 0.1 * Math.sin(elapsed * 5.1 - i * 0.4))
                            : (0.2 + 0.15 * Math.sin(elapsed * 3 + i * 0.4));
                        level = wave;
                    }

                    const activeBlocks = Math.round(level * maxBlocks);
                    const x = startX + i * (barWidth + barGap);

                    if (activeBlocks >= terminalPeaks[i]) {
                        terminalPeaks[i] = activeBlocks;
                        terminalPeakDecay[i] = elapsed;
                    } else if (elapsed - terminalPeakDecay[i] > 0.2) {
                        terminalPeaks[i] = Math.max(0, terminalPeaks[i] - 0.4);
                    }

                    for (let b = 0; b < maxBlocks; b++) {
                        const y = centerY + 46 - b * (blockHeight + blockGap);
                        const isActive = b < activeBlocks;
                        const isPeak = Math.floor(terminalPeaks[i]) === b && b > 0;

                        if (isActive || isPeak) {
                            const alpha = (isPeak ? 1.0 : (0.4 + (b / maxBlocks) * 0.6));
                            canvasCtx.fillStyle = `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha})`;
                            canvasCtx.shadowColor = `rgba(${col.r}, ${col.g}, ${col.b}, 0.8)`;
                            canvasCtx.shadowBlur = isPeak ? 6 : 2;
                        } else {
                            canvasCtx.fillStyle = `rgba(${col.r}, ${col.g}, ${col.b}, ${isTranscribing ? 0.16 : 0.08})`;
                            canvasCtx.shadowBlur = 0;
                        }

                        canvasCtx.fillRect(x, y, barWidth, blockHeight);
                    }
                }
                canvasCtx.shadowBlur = 0;

            } else {
                // Crimson mode (default)
                const bars = 32;
                const step = (Math.PI * 2) / bars;
                const baseRadius = 29;
                const rot = elapsed * (isTranscribing ? 0.5 : 0.35);
                const breath = isRecordingNow ? 1 : 0.55 + 0.45 * Math.sin(elapsed * 1.6);

                canvasCtx.lineCap = 'round';

                for (let i = 0; i < bars; i++) {
                    let barHeight, intensity;
                    if (isRecordingNow) {
                        const binIndex = Math.min(bufferLength - 1, Math.floor((i * bufferLength) / bars));
                        const target = dataArray[binIndex] || 0;
                        smoothValues[i] += (target - smoothValues[i]) * 0.3;
                        const val = smoothValues[i];
                        barHeight = 6 + (val / 255) * 22;
                        intensity = val / 255;
                    } else {
                        const wave = isTranscribing
                            ? (0.5 + 0.25 * Math.sin(elapsed * 3.4 - i * 0.6))
                            : (0.5 + 0.5 * Math.sin(elapsed * 1.6 - i * 0.55));
                        barHeight = (isTranscribing ? 6 : 4) + wave * (isTranscribing ? 7 : 5);
                        intensity = 0.35 + 0.25 * wave;
                    }

                    const angle = i * step + rot;
                    const cos = Math.cos(angle);
                    const sin = Math.sin(angle);

                    const x1 = centerX + cos * baseRadius;
                    const y1 = centerY + sin * baseRadius;
                    const h2 = baseRadius + barHeight * breath;
                    const x2 = centerX + cos * h2;
                    const y2 = centerY + sin * h2;

                    const alpha = isActiveNow ? (0.7 + intensity * 0.3) : (0.35 + intensity * 0.25);
                    canvasCtx.strokeStyle = `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha})`;
                    canvasCtx.lineWidth = isActiveNow ? (2 + intensity * 2) : 1.6;
                    if (isActiveNow) {
                        canvasCtx.shadowColor = `rgba(${col.r}, ${col.g}, ${col.b}, 0.55)`;
                        canvasCtx.shadowBlur = 6 + intensity * 6;
                    } else {
                        canvasCtx.shadowColor = 'transparent';
                        canvasCtx.shadowBlur = 0;
                    }

                    canvasCtx.beginPath();
                    canvasCtx.moveTo(x1, y1);
                    canvasCtx.lineTo(x2, y2);
                    canvasCtx.stroke();
                }

                canvasCtx.strokeStyle = isActiveNow
                    ? `rgba(${col.r}, ${col.g}, ${col.b}, 0.3)`
                    : `rgba(${col.r}, ${col.g}, ${col.b}, 0.22)`;
                canvasCtx.lineWidth = 1;
                canvasCtx.beginPath();
                canvasCtx.arc(centerX, centerY, baseRadius + 1, 0, Math.PI * 2);
                canvasCtx.stroke();
            }

        } catch (vizErr) {
            if (!vizErrLogged) {
                vizErrLogged = true;
                window.VTC?.recording?.log(`[render] visualizer exception: ${String(vizErr && vizErr.stack ? vizErr.stack : vizErr).slice(0, 400)}`);
            }
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopVisualizer();
        else startVisualizer();
    });

    function resetVisualizer() {
        smoothValues.fill(0);
        terminalPeaks.fill(0);
        terminalPeakDecay.fill(0);
        if (canvasCtx && canvas) canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    }

    window.VTC.visualizer = {
        getStyleColors,
        drawVisualizer,
        startVisualizer,
        stopVisualizer,
        resetVisualizer
    };
})();
