const assert = require('node:assert/strict');
const test = require('node:test');
const { migrateConfig, validateSttConfig, recommendedTierForRam, WIDGET_STYLES } = require('../stt/config');

test('recommendedTierForRam maps memory to tiers monotonically', () => {
    assert.equal(recommendedTierForRam(4), 'tiny');
    assert.equal(recommendedTierForRam(8), 'mini');
    assert.equal(recommendedTierForRam(12), 'light');
    assert.equal(recommendedTierForRam(16), 'light');
    assert.equal(recommendedTierForRam(32), 'big');
});

test('WIDGET_STYLES single source of truth exports expected four styles', () => {
    assert.deepEqual(WIDGET_STYLES, ['crimson', 'ocean', 'aurora', 'terminal']);
});

test('validateSttConfig coerces engine/model/tier to safe defaults', () => {
    const v = validateSttConfig({ sttEngine: 'nope', geminiModel: 'evil-model', localTier: 'huge', widgetStyle: 'unknown' });
    assert.equal(v.sttEngine, 'local');
    assert.equal(v.geminiModel, 'gemini-2.5-flash');
    assert.equal(v.localLanguage, 'auto');
    assert.equal(typeof v.localModelKey, 'string');
    assert.equal(v.ecoMode, true);
    assert.equal(v.playFinishSound, true);
    assert.equal(v.saveRecordings, false);
    assert.equal(v.widgetStyle, 'crimson');
});

test('validateSttConfig accepts gemini engine + valid model, terminal widgetStyle, and validates saveRecordings boolean', () => {
    const v = validateSttConfig({ sttEngine: 'gemini', geminiModel: 'gemini-2.5-pro', saveRecordings: true, widgetStyle: 'terminal' });
    assert.equal(v.sttEngine, 'gemini');
    assert.equal(v.geminiModel, 'gemini-2.5-pro');
    assert.equal(v.saveRecordings, true);
    assert.equal(v.widgetStyle, 'terminal');
});

test('migrateConfig fills defaults and preserves the api key out of band', () => {
    const m = migrateConfig({});
    assert.ok(m && typeof m === 'object');
    assert.equal(m.configVersion, 6);
    assert.equal(m.localLanguage, 'auto');
    assert.equal(m.saveRecordings, false);
    assert.equal(m.micDeviceId, '');
    assert.equal(m.micDeviceLabel, '');
    assert.equal(m.historyEnabled, false);
    assert.equal(m.historyLimit, 50);
    assert.equal(m.outputMode, 'clipboard');
    assert.equal(m.autotypeMethod, 'unicode');

    const m2 = migrateConfig({ saveRecordings: true, micDeviceId: 'mic-123', micDeviceLabel: 'USB Mic', historyEnabled: true, historyLimit: 25, spacePaste: true, pasteStyle: 'toast' });
    assert.equal(m2.saveRecordings, true);
    assert.equal(m2.micDeviceId, 'mic-123');
    assert.equal(m2.micDeviceLabel, 'USB Mic');
    assert.equal(m2.historyEnabled, true);
    assert.equal(m2.historyLimit, 25);
    assert.equal(m2.outputMode, 'toast');
});

test('validateSttConfig includes mic, history, outputMode, and autotypeMethod settings', () => {
    const v = validateSttConfig({ micDeviceId: 'dev-1', micDeviceLabel: 'My Mic', historyEnabled: true, historyLimit: 600, outputMode: 'autotype', autotypeMethod: 'paste' });
    assert.equal(v.micDeviceId, 'dev-1');
    assert.equal(v.micDeviceLabel, 'My Mic');
    assert.equal(v.historyEnabled, true);
    assert.equal(v.historyLimit, 500); // clamped to 500
    assert.equal(v.outputMode, 'autotype');
    assert.equal(v.autotypeMethod, 'paste');
});

test('win32 module exports typeUnicodeText function', () => {
    const win32 = require('../win32');
    assert.equal(typeof win32.typeUnicodeText, 'function');
});

