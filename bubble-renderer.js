// Bubble interaction: shows the clipped transcript, then the configured paste
// key (or Enter) pastes into the previously-focused window; Escape dismisses.
// `settled` guards against double-paste/double-dismiss: once the bubble has
// acted on a key, every later keystroke in the same window is ignored (the
// main process destroys the window, but a queued event can still land).
const el = document.getElementById('t');
const keyHint = document.getElementById('key-hint');
const titleEl = document.getElementById('title');
let pasteKey = ' ';
let settled = false;

window.bubbleApi.onSetText((payload) => {
    const data = (typeof payload === 'string') ? { text: payload } : (payload || {});
    settled = false;
    el.textContent = data.text || '';
    if (data.key) pasteKey = data.key;
    if (data.keyLabel) keyHint.textContent = data.keyLabel;
    if (data.title) titleEl.textContent = data.title;
    if (data.style) document.documentElement.setAttribute('data-widget-style', data.style);
});

window.addEventListener('keydown', (e) => {
    if (settled) { e.preventDefault(); return; }
    const isPasteKey = pasteKey === 'Enter' ? e.key === 'Enter' : e.key === pasteKey;
    if (isPasteKey || e.key === 'Enter') {
        e.preventDefault();
        settled = true;
        window.bubbleApi.paste();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        settled = true;
        window.bubbleApi.dismiss();
    }
});
