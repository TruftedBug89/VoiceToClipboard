// src/main/i18n.js
// Offline bundled locales and translation helper for the main process.

const { app } = require('electron');

const LOCALES = {
    en: require('../../locales/en.json'),
    es: require('../../locales/es.json'),
    zh: require('../../locales/zh.json')
};

/**
 * Maps a locale string to a supported UI language ('en', 'es', 'zh').
 * @param {string} [localeStr]
 * @returns {'en'|'es'|'zh'}
 */
function mapUiLanguage(localeStr) {
    const l = String(localeStr || '').toLowerCase();
    if (l.startsWith('es')) return 'es';
    if (l.startsWith('zh')) return 'zh';
    return 'en';
}

/**
 * Translates a key with optional variable substitutions.
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 * @param {string} [lang]
 * @returns {string}
 */
function L(key, vars, lang = 'en') {
    let v = (LOCALES[String(lang).toLowerCase()] || LOCALES.en)[key];
    if (v === undefined || v === null) v = LOCALES.en[key];
    if (v === undefined || v === null) v = key;
    v = String(v);
    if (vars) {
        // Single pass: substituted values are never re-scanned for more
        // placeholders (prevents chained substitution when a value itself
        // contains "{key}"-shaped text).
        v = v.replace(/\{(\w+)\}/g, (m, k) => Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
    }
    return v;
}

module.exports = {
    LOCALES,
    mapUiLanguage,
    L
};
