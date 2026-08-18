// src/renderer/i18n.js
// Client-side internationalization, DOM localization, and floating hint tooltips.

window.VTC = window.VTC || {};

(function () {
    const LOCALES = window.api && window.api.locales ? window.api.locales : { en: {}, es: {}, zh: {} };
    let uiLang = 'en';
    let locale = LOCALES.en || {};

    /**
     * Looks up a (possibly dotted) key in a locale dictionary.
     * @param {object} dict
     * @param {string} key
     * @returns {string|undefined}
     */
    function lookup(dict, key) {
        const k = String(key);
        // Locale files are flat (dots embedded in key names, e.g. "mic.default"),
        // with a few nested objects (e.g. appearance.style.crimson). Prefer the
        // exact flat key, then fall back to dotted traversal for nested dicts.
        if (dict && typeof dict === 'object' && Object.prototype.hasOwnProperty.call(dict, k)) {
            const v = dict[k];
            return typeof v === 'string' ? v : undefined;
        }
        let v = dict;
        for (const part of k.split('.')) {
            if (v && typeof v === 'object' && part in v) v = v[part];
            else return undefined;
        }
        return typeof v === 'string' ? v : undefined;
    }

    /**
     * Translates a key with optional template variable replacements.
     * @param {string} key
     * @param {Record<string, string|number>} [vars]
     * @param {string} [fallback]
     * @returns {string}
     */
    function t(key, vars, fallback) {
        let v = lookup(locale, key);
        if (v === undefined) v = lookup(LOCALES.en, key);
        if (v === undefined) v = (fallback !== undefined ? fallback : key);
        v = String(v);
        if (vars) {
            for (const k of Object.keys(vars)) v = v.split('{' + k + '}').join(String(vars[k]));
        }
        return v;
    }

    /**
     * Translates standard or dynamic status messages.
     * @param {string} msg
     * @returns {string}
     */
    function tr(msg) {
        if (typeof msg !== 'string') return msg;
        if (msg === '✓ COPIED') return t('status.COPIED');
        if (msg === '✓ TYPED') return t('status.TYPED');
        if (msg === '✓ MODEL READY') return t('status.MODEL_READY');
        const norm = msg.trim().replace(/\s+/g, '_');
        const m = locale['status.' + norm];
        if (m !== undefined) return m;
        if (msg.startsWith('PAUSE (')) return t('status.PAUSE') + msg.slice(5);
        if (msg.startsWith('REC')) return t('status.REC');
        return msg;
    }

    // Shared floating info tooltip
    const hintTooltip = document.createElement('div');
    hintTooltip.id = 'hint-tooltip';
    hintTooltip.setAttribute('role', 'tooltip');
    hintTooltip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(hintTooltip);

    function showHintTooltip(el) {
        const text = el.getAttribute('data-hint') || el.getAttribute('aria-label') || '';
        if (!text) return;
        hintTooltip.textContent = text;
        hintTooltip.setAttribute('aria-hidden', 'false');
        hintTooltip.style.visibility = 'visible';
        hintTooltip.style.opacity = '1';
        const r = el.getBoundingClientRect();
        const tw = hintTooltip.offsetWidth;
        const th = hintTooltip.offsetHeight;
        let left = Math.round(r.left + r.width / 2 - tw / 2);
        left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
        let top = Math.round(r.top - th - 10);
        if (top < 8) top = Math.round(r.bottom + 10);
        hintTooltip.style.left = left + 'px';
        hintTooltip.style.top = top + 'px';
    }

    function hideHintTooltip() {
        hintTooltip.setAttribute('aria-hidden', 'true');
        hintTooltip.style.opacity = '0';
        hintTooltip.style.visibility = 'hidden';
    }

    document.addEventListener('mouseover', (e) => {
        const el = e.target && e.target.closest && e.target.closest('.info-hint');
        if (el) showHintTooltip(el);
    });
    document.addEventListener('mouseout', (e) => {
        const el = e.target && e.target.closest && e.target.closest('.info-hint');
        if (el && (!e.relatedTarget || !el.contains(e.relatedTarget))) hideHintTooltip();
    });
    document.addEventListener('focusin', (e) => {
        if (e.target && e.target.classList && e.target.classList.contains('info-hint')) showHintTooltip(e.target);
    });
    document.addEventListener('focusout', (e) => {
        if (e.target && e.target.classList && e.target.classList.contains('info-hint')) hideHintTooltip();
    });

    /**
     * Applies internationalization translations to all data-i18n DOM attributes.
     * @param {string} [lang]
     */
    function applyI18n(lang) {
        uiLang = lang || 'en';
        locale = LOCALES[uiLang] || LOCALES.en;
        document.documentElement.lang = uiLang === 'zh' ? 'zh-CN' : (uiLang === 'es' ? 'es' : 'en');
        document.title = t('app.name');
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const val = t(key, null, el.textContent.trim());
            const hasElementChildren = Array.from(el.children).some(c => c.tagName !== 'BR');
            if (hasElementChildren) return;
            const onlyIcon = el.textContent.trim().length <= 3 && /[\u2190-\u27BF\u2B00-\u2BFF\uFE0F\u2600-\u27EF]/.test(el.textContent);
            if (onlyIcon) return;
            el.textContent = val;
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
        });
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const label = t(el.getAttribute('data-i18n-title'));
            el.setAttribute('title', label);
            el.setAttribute('aria-label', label);
        });
        document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
            el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
        });
        document.querySelectorAll('[data-i18n-hint]').forEach(el => {
            const hint = t(el.getAttribute('data-i18n-hint'));
            el.setAttribute('data-hint', hint);
            el.setAttribute('aria-label', hint);
        });

        const recoNote = document.getElementById('model-reco-note');
        if (recoNote) {
            const reco = '<span class="text-gold">' + t('models.recommended') + '</span>';
            // Keep the RAM span alive (applyModelRecommendation fills it after
            // systemRamGB is known) and re-append the quality note so it isn't
            // destroyed when models.note is re-rendered here.
            const ram = '<span id="model-reco-ram"></span>';
            recoNote.innerHTML = t('models.note', { reco, ram }) + ' <span>' + t('models.qualityNote') + '</span>';
        }

        if (window.VTC?.settings?.applyModelRecommendation) {
            window.VTC.settings.applyModelRecommendation(null);
        }
        if (window.VTC?.settings?.rebuildModelViews) {
            window.VTC.settings.rebuildModelViews();
        }
    }

    function setUiLanguage(lang) {
        applyI18n(lang);
        if (window.VTC?.settings?.applyModelRecommendation) {
            window.VTC.settings.applyModelRecommendation(null);
        }
        // Dynamic-DOM views have no data-i18n bindings, so re-render them on
        // language switch: history cards and the mic device dropdown.
        if (window.VTC?.settings?.renderHistoryList) {
            window.VTC.settings.renderHistoryList();
        }
        if (window.VTC?.audio?.populateMicDevices) {
            window.VTC.audio.populateMicDevices();
        }
    }

    window.VTC.i18n = {
        t,
        tr,
        applyI18n,
        setUiLanguage,
        get uiLang() { return uiLang; },
        get locale() { return locale; }
    };
})();
