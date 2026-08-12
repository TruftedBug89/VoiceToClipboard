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
    assert.equal(m.localLanguage, 'auto');
    assert.equal(m.saveRecordings, false);

    const m2 = migrateConfig({ saveRecordings: true });
    assert.equal(m2.saveRecordings, true);
});
