const assert = require('node:assert/strict');
const test = require('node:test');
const { MODEL_REGISTRY, getModel, getModelKey } = require('../stt/model-registry');
const { sanitizeErrorMessage } = require('../stt/error-sanitizer');

test('registry has six auto-language models with licenses and urls', () => {
    const keys = Object.keys(MODEL_REGISTRY);
    assert.equal(keys.length, 6);
    for (const k of keys) {
        const m = MODEL_REGISTRY[k];
        const src = JSON.stringify(m);
        assert.ok(/https?:\/\//.test(src), `${k} needs an archive url somewhere in its entry`);
        assert.ok(m.license, `${k} needs a license`);
    }
});

test('getModelKey maps every tier to a registered key', () => {
    for (const tier of ['tiny', 'mini', 'zh-light', 'light', 'big', 'zh-big']) {
        assert.ok(getModel(getModelKey(tier)), `tier ${tier} resolves to a model`);
    }
    assert.equal(getModelKey('bogus'), 'omni-multilingual');
});

test('getModel throws for unknown keys (defensive registry)', () => {
    assert.throws(() => getModel('does-not-exist'), /Unknown local model/);
});

test('sanitizeErrorMessage redacts Gemini-style API keys', () => {
    const out = sanitizeErrorMessage(new Error('request failed with key=AIzaSyDXXXXXXXXXXXXXXXXXXXXXXXXXX in url'));
    assert.ok(!out.includes('AIzaSy'), 'key fragment should be redacted');
    assert.match(out, /REDACTED/);
});

test('sanitizeErrorMessage redacts bearer tokens and key fields', () => {
    assert.match(sanitizeErrorMessage('Authorization: Bearer abc.def.ghi'), /REDACTED/);
    assert.match(sanitizeErrorMessage('api_key=sk-1234567890'), /REDACTED/);
    assert.equal(sanitizeErrorMessage('plain message'), 'plain message');
});
