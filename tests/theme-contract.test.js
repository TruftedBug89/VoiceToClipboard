// CSS contract guards for the "old idle look + 4.1.5 active states" build the
// user requested. These fail loudly if a future edit re-introduces the old
// green success tick, drops a theme's recording gradient, or reverts the old
// settings surface — regressions that are easy to miss by eye.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const themes = read('styles/themes.css');
const base = read('styles/base.css');
const settings = read('styles/settings.css');

test('every theme has its own 4.1.5 recording gradient', () => {
    assert.match(themes, /linear-gradient\(145deg, #ff3b4e, #e11d48\)/, 'crimson');
    assert.match(themes, /linear-gradient\(145deg, #06b6d4, #0284c7\)/, 'ocean');
    assert.match(themes, /linear-gradient\(145deg, #a855f7, #ec4899\)/, 'aurora');
    assert.match(themes, /linear-gradient\(145deg, #00ff66, #00dd55\)/, 'terminal');
});

test('idle colors stay on the old v4.1.1 palette', () => {
    assert.match(themes, /--primary: #0ea5e9;/, 'ocean idle primary');
    assert.match(themes, /--primary: #a855f7;/, 'aurora idle primary');
    assert.match(themes, /--primary: #00ff66;/, 'terminal idle primary');
});

test('the 4.1.5 comet spinner + breathe animation are intact in base.css', () => {
    assert.match(base, /transcribing-breathe/);
    assert.match(base, /#mic-container\.transcribing \.spin-ring/);
    assert.match(base, /conic-gradient/);
});

test('success tick uses the theme accent, not a fixed green', () => {
    // The old build hardcoded a green success glow; the 4.1.5 build ties it to
    // var(--primary). Guard against a silent reversion to green.
    assert.match(base, /#mic-button\.show-check[\s\S]*?var\(--primary\)/);
    assert.doesNotMatch(base, /#mic-button\.show-check[\s\S]*?#4ade80/);
});

test('settings keeps the old v4.1.1 window surface and 4.1.5 additions', () => {
    assert.match(settings, /body\.settings-window/);
    assert.match(settings, /\.info-hint/);
    assert.match(settings, /\.switch-label-group/);
    assert.match(settings, /#hint-tooltip/);
    // Old look: hardcoded crimson accent in the separate settings window.
    assert.match(settings, /background: #d64956;/);
});
