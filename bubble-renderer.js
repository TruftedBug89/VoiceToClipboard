// Bubble interaction: shows the clipped transcript, then SPACE/Enter pastes
// into the previously-focused window, Escape dismisses.
const el = document.getElementById('t');
const keyHint = document.getElementById('key-hint');
const titleEl = document.getElementById('title');
let pasteKey = ' ';
window.bubbleApi.onSetText((payload) => {
    const data = (typeof payload === 'string') ? { text: payload } : (payload || {});
    el.textContent = data.text || '';
    if (data.key) pasteKey = data.key;
    if (data.keyLabel) keyHint.textContent = data.keyLabel;
    if (data.title) titleEl.textContent = data.title;
});
window.addEventListener('keydown', (e) => {
    if (e.key === pasteKey || e.key === 'Enter') { e.preventDefault(); window.bubbleApi.paste(); }
    else if (e.key === 'Escape') { window.bubbleApi.dismiss(); }
});
