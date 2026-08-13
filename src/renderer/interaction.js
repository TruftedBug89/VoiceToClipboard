// src/renderer/interaction.js
// Window dragging, click-through management, keyboard navigation, and global hotkey recording.

window.VTC = window.VTC || {};

(function () {
    const isSettingsWindow = new URLSearchParams(window.location.search).get('settings') === '1';
    const micContainer = document.getElementById('mic-container');
    const micBtn = document.getElementById('mic-button');
    const settingsModal = document.getElementById('settings-modal');
    const topBar = document.getElementById('top-bar');
    const hotkeyInput = document.getElementById('hotkey-input');
    const recordHotkeyBtn = document.getElementById('record-hotkey-btn');

    const DRAG_THRESHOLD = 3;
    let pointerDrag = null;
    let lastPointerEventTime = 0;
    let mouseIgnored = true;
    let mouseX = 0, mouseY = 0;
    let cursorInsideWindow = true;

    function endPointerDrag() {
        if (pointerDrag) {
            if (pointerDrag.dragTarget) {
                try { pointerDrag.dragTarget.releasePointerCapture(pointerDrag.pid); } catch (e) {}
                pointerDrag.dragTarget.classList.remove('dragging');
            }
            pointerDrag = null;
            if (micContainer) micContainer.classList.remove('dragging');
            window.api?.dragEnd();
        }
    }

    function refreshMouseIgnore() {
        if (pointerDrag && Date.now() - lastPointerEventTime > 8000) endPointerDrag();
        if (pointerDrag) return;

        if (isSettingsWindow) return;

        const isSettingsOpen = settingsModal && settingsModal.classList.contains('active');
        const isRecording = window.VTC?.recording?.isRecording;

        if (isSettingsOpen) {
            if (topBar) topBar.classList.add('visible');
            if (mouseIgnored) {
                mouseIgnored = false;
                window.api?.setIgnoreMouse(false);
            }
            return;
        }

        const isMouseHoverTop = cursorInsideWindow && (
            mouseY >= 0 && mouseY <= window.innerHeight * 0.33 && mouseX >= 0 && mouseX <= window.innerWidth
        );

        if (topBar) {
            topBar.classList.toggle('hover-active', !!isMouseHoverTop);
            topBar.classList.toggle('visible', !!(isMouseHoverTop || isRecording));
        }

        const hitEl = document.elementFromPoint(mouseX, mouseY);
        const overInteractiveEl = !!(hitEl && (hitEl.closest('#mic-button') || hitEl.closest('.icon-btn') || hitEl.closest('#retry-btn')));
        const interactive = overInteractiveEl || isSettingsOpen;

        document.body.classList.toggle('is-hovering', interactive);

        const shouldIgnore = !interactive;
        if (shouldIgnore !== mouseIgnored) {
            mouseIgnored = shouldIgnore;
            window.api?.setIgnoreMouse(shouldIgnore);
        }
    }

    document.addEventListener('pointerdown', (e) => {
        if (isSettingsWindow) return;

        if (e.target.closest('input, select, button, .segment-btn, .toggle-switch, .slider, #close-modal-btn, #close-btn, #settings-btn, #cancel-btn, #retry-btn, a')) {
            return;
        }

        const isMicContainer = micContainer && micContainer.contains(e.target);
        const isMicButton = micBtn && micBtn.contains(e.target);
        const isSettingsModal = settingsModal && settingsModal.contains(e.target);

        if (isMicContainer || isSettingsModal) {
            const dragTarget = isSettingsModal ? settingsModal : micContainer;
            pointerDrag = {
                pid: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                moved: false,
                isMicClick: isMicButton,
                dragTarget
            };
            lastPointerEventTime = Date.now();
            try { dragTarget.setPointerCapture(e.pointerId); } catch (err) {}
            window.api?.dragStart();
        }
    });

    document.addEventListener('pointermove', (e) => {
        lastPointerEventTime = Date.now();
        if (!pointerDrag || e.pointerId !== pointerDrag.pid) return;
        if (!pointerDrag.moved &&
            Math.abs(e.clientX - pointerDrag.startX) + Math.abs(e.clientY - pointerDrag.startY) > DRAG_THRESHOLD) {
            pointerDrag.moved = true;
            if (pointerDrag.dragTarget) pointerDrag.dragTarget.classList.add('dragging');
        }
        if (pointerDrag.moved) {
            window.api?.dragMove();
        }
    });

    document.addEventListener('pointerup', (e) => {
        if (!pointerDrag || e.pointerId !== pointerDrag.pid) return;
        const wasDrag = pointerDrag.moved;
        const isMicClick = pointerDrag.isMicClick;
        endPointerDrag();
        refreshMouseIgnore();

        const isSettingsOpen = settingsModal && settingsModal.classList.contains('active');
        if (!wasDrag && isMicClick && !isSettingsOpen) {
            const isRecording = window.VTC?.recording?.isRecording;
            if (!isRecording) {
                window.VTC?.recording?.startRecording();
            } else {
                window.VTC?.recording?.stopRecording();
            }
        }
    });

    document.addEventListener('pointercancel', (e) => {
        if (pointerDrag && e.pointerId === pointerDrag.pid) endPointerDrag();
    });

    document.addEventListener('lostpointercapture', (e) => {
        if (pointerDrag && e.pointerId === pointerDrag.pid) endPointerDrag();
    });

    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
        refreshMouseIgnore();
    });

    document.addEventListener('mouseleave', () => {
        cursorInsideWindow = false;
        document.body.classList.remove('is-hovering');
        if (pointerDrag) return;
        const isSettingsOpen = settingsModal && settingsModal.classList.contains('active');
        if (!isSettingsOpen) {
            if (topBar) topBar.classList.remove('visible', 'hover-active');
            if (!mouseIgnored) {
                mouseIgnored = true;
                window.api?.setIgnoreMouse(true);
            }
        }
    });

    window.api?.on('widget-hover', (payload) => {
        const inside = typeof payload === 'boolean' ? payload : !!(payload && payload.inside);
        cursorInsideWindow = inside;
        if (!inside) {
            document.body.classList.remove('is-hovering');
            if (pointerDrag) return;
            const isSettingsOpen = settingsModal && settingsModal.classList.contains('active');
            const isRecording = window.VTC?.recording?.isRecording;
            if (!isSettingsOpen && !isRecording) {
                if (topBar) topBar.classList.remove('visible', 'hover-active');
                if (!mouseIgnored) {
                    mouseIgnored = true;
                    window.api?.setIgnoreMouse(true);
                }
            }
            return;
        }
        if (payload && typeof payload === 'object' && typeof payload.x === 'number') {
            mouseX = payload.x;
            mouseY = payload.y;
        }
        refreshMouseIgnore();
    });

    document.addEventListener('keydown', (e) => {
        const isRecording = window.VTC?.recording?.isRecording;
        if ((e.key === 'Enter' || e.key === ' ') && e.target === micBtn) {
            e.preventDefault();
            if (!isRecording) window.VTC?.recording?.startRecording();
            else window.VTC?.recording?.stopRecording();
        } else if (isRecording && e.key === 'Escape') {
            window.VTC?.recording?.cancelRecording();
        }
    });

    async function loadHotkey() {
        if (!hotkeyInput) return;
        const currentKey = await window.api?.getHotkey();
        hotkeyInput.value = currentKey || 'CommandOrControl+Alt+V';
    }

    function startHotkeyRecording() {
        if (!hotkeyInput || !recordHotkeyBtn) return;
        const t = window.VTC?.i18n?.t || ((k) => k);
        hotkeyInput.value = 'Press key or mouse btn...';
        hotkeyInput.style.borderColor = 'var(--primary)';
        recordHotkeyBtn.textContent = t('autostop.calibrate.listening', { s: '…' });

        window.api?.startRecordingHotkey().then((newHotkeyStr) => {
            hotkeyInput.style.borderColor = 'rgba(255, 255, 255, 0.15)';
            recordHotkeyBtn.textContent = 'Change Key';
            if (newHotkeyStr) {
                hotkeyInput.value = newHotkeyStr;
                const note = document.getElementById('hotkey-note');
                if (note) note.innerHTML = '<span style="color: #10b981;">✓ Hotkey updated</span>';
                setTimeout(() => {
                    if (note && note.innerHTML.includes('✓')) note.innerHTML = 'Click input or Change Key, then press key combination.';
                }, 3000);
            }
        });
    }

    if (hotkeyInput) hotkeyInput.addEventListener('click', startHotkeyRecording);
    if (recordHotkeyBtn) recordHotkeyBtn.addEventListener('click', startHotkeyRecording);

    window.VTC.interaction = {
        refreshMouseIgnore,
        endPointerDrag,
        startHotkeyRecording,
        loadHotkey,
        get mouseIgnored() { return mouseIgnored; }
    };
})();
