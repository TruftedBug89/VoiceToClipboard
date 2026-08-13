// tests/main-modules.test.js
// Unit tests for split main process modules: delivery, recordings, history, and i18n.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
