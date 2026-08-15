// tests/main-modules.test.js
// Unit tests for split main process modules: delivery, recordings, history, and i18n.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const themeBootstrapSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'theme-bootstrap.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');
const { clipTranscript } = require('../src/main/delivery');
const { audioPayloadBytes } = require('../src/main/recordings-store');
const { L, mapUiLanguage } = require('../src/main/i18n');

test('clipTranscript bounds text with ellipsis when long', () => {
    assert.equal(clipTranscript('short text'), 'short text');
    const longText = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
    const clipped = clipTranscript(longText, 50, 30);
    assert.ok(clipped.includes('…'), 'should include ellipsis');
    assert.ok(clipped.length < longText.length, 'should be shorter than original');
});

test('audioPayloadBytes accurately measures typed arrays, array buffers, and views', () => {
    assert.equal(audioPayloadBytes(null), 0);
    assert.equal(audioPayloadBytes({}), 0);

    const f32 = new Float32Array(100);
    assert.equal(audioPayloadBytes({ pcm: f32 }), 400);

    const rawArray = [0.1, 0.2, 0.3];
    assert.equal(audioPayloadBytes({ pcm: rawArray }), 12);

    const buf = new ArrayBuffer(256);
    assert.equal(audioPayloadBytes({ arrayBuffer: buf }), 256);
});

test('main i18n helper resolves translations and variable interpolations', () => {
    assert.equal(mapUiLanguage('es-ES'), 'es');
    assert.equal(mapUiLanguage('zh-CN'), 'zh');
    assert.equal(mapUiLanguage('fr-FR'), 'en');

    const enText = L('tray.quit', null, 'en');
    assert.equal(enText, '❌ Quit');

    const esText = L('tray.quit', null, 'es');
    assert.equal(esText, '❌ Salir');

    const zhText = L('tray.quit', null, 'zh');
    assert.equal(zhText, '❌ 退出');

    const formatted = L('autostop.seconds.1.5', null, 'en');
    assert.equal(formatted, '1.5 sec');
});

test('main process resolves live window state instead of a destructured null getter', () => {
    assert.match(mainSource, /const windows = require\('\.\/src\/main\/windows'\);/);
    assert.match(mainSource, /initForegroundPolling\(\(\) => windows\.mainWindow\)/);
    assert.doesNotMatch(mainSource, /broadcastSettingsChanged,\s*mainWindow/);
    assert.match(ipcSource, /windows\.mainWindow\.setIgnoreMouseEvents/);
    assert.doesNotMatch(ipcSource, /if \(mainWindow \|\| mainWindow\.isDestroyed\(\)\)/);
    assert.match(ipcSource, /delivery\.lastDeliveryTyped/);
    assert.match(ipcSource, /hotkeys\.currentHotkeyConfig/);
});

test('foreground polling supports every target-dependent output mode', () => {
    const deliverySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'delivery.js'), 'utf8');
    assert.match(deliverySource, /config\.outputMode === 'autotype'/);
    assert.match(deliverySource, /config\.outputMode === 'bubble'/);
    assert.match(deliverySource, /config\.outputMode === 'toast'/);
});

test('theme bootstraps before model loading and does not hard-code Crimson active', () => {
    assert.match(preloadSource, /getInitialAppearance: \(\) => ipcRenderer\.sendSync\('get-initial-appearance'\)/);
    assert.match(htmlSource, /<script src="src\/renderer\/theme-bootstrap\.js"><\/script>/);
    assert.match(themeBootstrapSource, /setAttribute\('data-widget-style'/);
    const initStart = rendererSource.indexOf('async function initializeRenderer()');
    const snapshotIndex = rendererSource.indexOf('const snapshot = await window.api?.getSttConfig()', initStart);
    const catalogIndex = rendererSource.indexOf('await window.VTC.settings.loadModelCatalog()', initStart);
    assert.ok(initStart >= 0 && snapshotIndex > initStart && catalogIndex > snapshotIndex);
    assert.doesNotMatch(htmlSource, /style-swatch active[^>]+data-style="crimson"/);
    assert.match(htmlSource, /id="app-version-display">v4\.1\.5/);
});

test('visualizer is demand-driven and VAD is not coupled to canvas frames', () => {
    const visualizerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'visualizer.js'), 'utf8');
    const recordingSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'recording.js'), 'utf8');
    assert.match(visualizerSource, /function startVisualizer\(\)/);
    assert.match(visualizerSource, /function stopVisualizer\(\)/);
    assert.doesNotMatch(visualizerSource, /processVadFrame/);
    assert.match(recordingSource, /setInterval\(\(\) => \{/);
    assert.match(recordingSource, /processVadFrame\(vadBuffer\)/);
});

test('transcribing state does not shadow the state helper (no TDZ draw failure)', () => {
    const visualizerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'visualizer.js'), 'utf8');
    assert.match(visualizerSource, /function isTranscribingState\(\)/);
    assert.match(visualizerSource, /const isTranscribing = !isRecordingNow && isTranscribingState\(\)/);
    assert.doesNotMatch(visualizerSource, /const isTranscribingNow = !isRecordingNow && isTranscribingNow\(\)/);
});

test('widget boot shows busy feedback and main window is created before model preparation', () => {
    const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(rendererSource, /setStatus\('busy', 'STARTING'\)/);
    assert.match(mainSource, /backgroundPrepare\(\)/);
    const createIndex = mainSource.indexOf('createMainWindow()');
    const prepareIndex = mainSource.indexOf('sttService.prepare()');
    assert.ok(prepareIndex > createIndex, 'model prepare must run after the widget window is created');
});

test('prepare uses metadata verification instead of forced full hashing on boot', () => {
    const sttSource = fs.readFileSync(path.join(__dirname, '..', 'stt', 'index.js'), 'utf8');
    assert.match(sttSource, /verifyInstalled\(key\)\.catch/);
    assert.doesNotMatch(sttSource, /verifyInstalled\(key, \{ force: true \}\)\.catch/);
});

test('model verification records metadata and supports cached validation', () => {
    const cacheSource = fs.readFileSync(path.join(__dirname, '..', 'stt', 'model-cache.js'), 'utf8');
    assert.match(cacheSource, /fileStats/);
    assert.match(cacheSource, /verificationInflight/);
    assert.match(cacheSource, /force = false/);
});

test('hotkey key whitelist accepts letters, digits, F-keys and rejects modifiers', () => {
    const { isCapturableKeyName, isModifierKeyName, isEscapeKeyName } = require('../src/main/hotkey-keys');
    assert.equal(isCapturableKeyName('A'), true);
    assert.equal(isCapturableKeyName('7'), true);
    assert.equal(isCapturableKeyName('F12'), true);
    assert.equal(isCapturableKeyName('NumPad1'), true);
    assert.equal(isCapturableKeyName('Space'), true);
    assert.equal(isCapturableKeyName('Minus'), true);
    assert.equal(isCapturableKeyName('Ctrl'), false);
    assert.equal(isCapturableKeyName('ShiftRight'), false);
    assert.equal(isCapturableKeyName('Meta'), false);
    assert.equal(isCapturableKeyName(null), false);
    assert.equal(isModifierKeyName('Alt'), true);
    assert.equal(isEscapeKeyName('Escape'), true);
});

test('gemini cooldown arithmetic prunes expired entries and reports earliest retry', () => {
    const { remainingCooldownMs, cooldownSummary } = require('../src/main/gemini');
    const now = 1000000;
    assert.equal(remainingCooldownMs({}, now), 0);
    assert.equal(remainingCooldownMs({ a: now - 500, b: now - 1 }, now), 0);
    assert.equal(remainingCooldownMs({ a: now + 5000, b: now + 8000 }, now), 5000);
    const summary = cooldownSummary({
        keyCooldowns: { k1: now + 4000, k2: now - 100 },
        modelCooldowns: { m1: now + 9000 },
        now
    });
    assert.equal(summary.keysActive, 1);
    assert.equal(summary.modelsActive, 1);
    // retryInMs is the longest active cooldown (retry when everything is free)
    assert.equal(summary.retryInMs, 9000);
    assert.equal(typeof summary.retryInMs, 'number');
});

test('renderer history search is debounced and sequence-guarded', () => {
    const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings-ui.js'), 'utf8');
    assert.match(settingsSource, /historySearchDebounce/);
    assert.match(settingsSource, /historyRenderSeq/);
    assert.match(settingsSource, /requestSeq !== historyRenderSeq/);
    assert.match(settingsSource, /setTimeout\(\(\) => \{\s*renderHistoryList\(historySearchInput\.value\);\s*\}, 180\)/);
});

test('first-run tour is non-blocking and marks completion via IPC', () => {
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const configSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config-store.js'), 'utf8');
    assert.match(preloadSource, /markFirstRunDone/);
    assert.match(rendererSource, /first-run-tour/);
    assert.match(htmlSource, /first-run-tour/);
    assert.match(configSource, /configFileExistedAtBoot/);
    assert.match(configSource, /firstRun: !configFileExistedAtBoot && config\.firstRunDone !== true/);
    const tourIndex = htmlSource.indexOf('class="first-run-tour"');
    const statusBadgeIndex = htmlSource.indexOf('id="status-badge"');
    assert.ok(tourIndex > 0 && statusBadgeIndex > tourIndex, 'tour markup exists before the status badge');
});

test('settings section titles are sticky and modal traps focus', () => {
    const cssSource = fs.readFileSync(path.join(__dirname, '..', 'styles', 'settings.css'), 'utf8');
    const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings-ui.js'), 'utf8');
    assert.match(cssSource, /\.settings-section-title \{[^}]*position: sticky/s);
    assert.match(settingsSource, /lastFocusedBeforeSettings/);
    assert.match(settingsSource, /e\.key !== 'Tab'/);
    assert.match(settingsSource, /e\.key === 'Escape'/);
});
