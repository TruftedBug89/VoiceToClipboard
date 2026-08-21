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
    // Click-through hysteresis lives entirely in the main-process hover poll:
    // while the cursor is within a 16px band just outside the window, the
    // "near" payload holds our current state, so edge-grazing can't flap the
    // ignore flag. Exits stay instant (a stale interactive window eats
    // clicks), but entry is debounced ~140ms to filter edge grazing.
    let pointerDrag = null;
    let lastPointerEventTime = 0;
    let mouseIgnored = true;
    let mouseX = 0, mouseY = 0;
    let cursorInsideWindow = true;
    // The main process owns the 16px exit hysteresis. This short entry delay
    // filters an edge graze before mouse events become interactive.
    const HOVER_ENTER_DEBOUNCE_MS = 140;
    let hoverActivationTimer = null;

    function clearHoverActivation() {
        if (hoverActivationTimer) {
            clearTimeout(hoverActivationTimer);
            hoverActivationTimer = null;
        }
    }

    function setMouseIgnored(nextIgnored, { debounceEnter = false } = {}) {
        if (nextIgnored) {
            clearHoverActivation();
            if (!mouseIgnored) {
                mouseIgnored = true;
                window.api?.setIgnoreMouse(true);
            }
            return;
        }
        if (!mouseIgnored) return;
        if (!debounceEnter) {
            clearHoverActivation();
            mouseIgnored = false;
            window.api?.setIgnoreMouse(false);
            return;
        }
        if (hoverActivationTimer) return;
        hoverActivationTimer = setTimeout(() => {
            hoverActivationTimer = null;
            if (cursorInsideWindow && !pointerDrag) {
                refreshMouseIgnore({ debounceEnter: false });
            }
        }, HOVER_ENTER_DEBOUNCE_MS);
    }

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

    function refreshMouseIgnore({ debounceEnter = true } = {}) {
        if (pointerDrag && Date.now() - lastPointerEventTime > 8000) endPointerDrag();
        if (pointerDrag) return;

        if (isSettingsWindow) return;

        const isSettingsOpen = (settingsModal && settingsModal.classList.contains('active')) || document.body.classList.contains('settings-active');
        const isRecording = window.VTC?.recording?.isRecording;

        if (isSettingsOpen) {
            if (topBar) topBar.classList.add('visible');
            setMouseIgnored(false);
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
        // Recording disables click-through across the widget so its live
        // controls remain reachable even when the pointer leaves the mic.
        const interactive = overInteractiveEl || isSettingsOpen || !!isRecording;

        document.body.classList.toggle('is-hovering', interactive);

        setMouseIgnored(!interactive, {
            debounceEnter: debounceEnter && interactive && !isSettingsOpen && !isRecording
        });
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
        clearHoverActivation();
        document.body.classList.remove('is-hovering');
        if (pointerDrag) return;
        // Let the main-process 16px exit band decide when to re-enable
        // click-through. An immediate leave here used to bypass hysteresis.
    });

    window.api?.on('widget-hover', (payload) => {
        const inside = typeof payload === 'boolean' ? payload : !!(payload && payload.inside);
        const near = !!(payload && typeof payload === 'object' && payload.near);
        cursorInsideWindow = inside;
        if (!inside) {
            clearHoverActivation();
            document.body.classList.remove('is-hovering');
            if (pointerDrag) return;
            const isSettingsOpen = settingsModal && settingsModal.classList.contains('active');
            const isRecording = window.VTC?.recording?.isRecording;
            // Hysteresis band: while the cursor is within 16px outside the
            // window the main poll reports near=true — hold the current state
            // instead of re-ignoring, so edge grazing can't flap the flag.
            if (near) return;
            if (!isSettingsOpen && !isRecording) {
                if (topBar) topBar.classList.remove('visible', 'hover-active');
                setMouseIgnored(true);
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
        // Settings owns Escape while its dialog is open; otherwise this
        // listener would both cancel recording and close the modal.
        if (e.key === 'Escape' && settingsModal?.classList.contains('active')) return;
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
        const note = document.getElementById('hotkey-note');
        hotkeyInput.value = 'Press key or mouse btn...';
        hotkeyInput.style.borderColor = 'var(--primary)';
        recordHotkeyBtn.textContent = t('hotkey.listening');
        if (note) note.textContent = t('hotkey.listeningNote');

        window.api?.startRecordingHotkey().then(async (payload) => {
            hotkeyInput.style.borderColor = 'rgba(255, 255, 255, 0.15)';
            recordHotkeyBtn.textContent = t('hotkey.change');
            const res = (payload && typeof payload === 'object') ? payload : { result: 'ok', hotkey: payload };
            if (res.result === 'ok') {
                hotkeyInput.value = res.hotkey || (await window.api?.getHotkey());
                if (note) note.innerHTML = '<span style="color: #10b981;">✓ ' + t('hotkey.updated') + '</span>';
                setTimeout(() => {
                    if (note && note.textContent.includes('✓')) note.textContent = t('hotkey.note');
                }, 3000);
            } else if (res.result === 'cancelled') {
                hotkeyInput.value = res.hotkey || (await window.api?.getHotkey());
                if (note) note.textContent = t('hotkey.cancelled');
                setTimeout(() => { if (note) note.textContent = t('hotkey.note'); }, 3000);
            } else if (res.result === 'invalid') {
                hotkeyInput.value = res.hotkey || (await window.api?.getHotkey());
                if (note) note.textContent = t('hotkey.invalid');
                setTimeout(() => { if (note) note.textContent = t('hotkey.note'); }, 4000);
            } else {
                // timeout
                hotkeyInput.value = res.hotkey || (await window.api?.getHotkey());
                if (note) note.textContent = t('hotkey.timeout');
                setTimeout(() => { if (note) note.textContent = t('hotkey.note'); }, 3000);
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
