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

test('sanitizeErrorMessage redacts suffixed query-param secret names', () => {
    const out = sanitizeErrorMessage(new Error('GET https://host/v1/x?refresh_token=abc123def456&authkey=zzz999888 failed'));
    assert.ok(!out.includes('abc123def456'), 'refresh_token value must be redacted');
    assert.ok(!out.includes('zzz999888'), 'authkey value must be redacted');
});

test('sanitizeErrorMessage redacts Basic-auth credentials and x-goog-api-key headers', () => {
    const out = sanitizeErrorMessage(new Error('Authorization: Basic dXNlcjpwYXNzd29yZA=='));
    assert.ok(!out.includes('dXNlcjpwYXNzd29yZA'), 'base64 basic credential must be redacted');
    const hdr = sanitizeErrorMessage(new Error('{"x-goog-api-key": "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"}'));
    assert.ok(!hdr.includes('AIzaSyXXXXXXXX'), 'header key material must be redacted');
});

test('sanitizeErrorMessage survives hostile thrown values and sanitizes causes', () => {
    const hostile = { get toString() { throw new Error('nope'); } };
    assert.equal(sanitizeErrorMessage(hostile), 'Unknown error');
    const inner = new Error('inner failed with key=AIzaSyDYYYYYYYYYYYYYYYYYYYYYYYYY');
    const outer = new Error('outer failed');
    outer.cause = inner;
    const out = sanitizeErrorMessage(outer);
    assert.ok(!out.includes('AIzaSyDYYYY'), 'cause-chain key material must be redacted');
});
