// Pre-paint theme bootstrap. Loaded synchronously in <head> before stylesheets
// so the saved widget style is applied before first paint. This is an external
// script and therefore satisfies the strict CSP script-src 'self'.
(function () {
    const WIDGET_STYLES = ['crimson', 'ocean', 'aurora', 'terminal'];

    function normalizedWidgetStyle(style) {
        return WIDGET_STYLES.includes(style) ? style : 'crimson';
    }

    function applyWidgetStyleAttribute(style) {
        document.documentElement.setAttribute('data-widget-style', normalizedWidgetStyle(style));
    }

    try {
        const appearance = window.api && typeof window.api.getInitialAppearance === 'function'
            ? window.api.getInitialAppearance()
            : null;
        const style = normalizedWidgetStyle(appearance && appearance.widgetStyle);
        applyWidgetStyleAttribute(style);
        // The async settings snapshot must not repaint a different theme after
        // this pre-paint read. Keep an internal marker (not user data) until
        // settings-ui consumes the first snapshot; later user changes still
        // take the normal theme-update path.
        if (appearance && WIDGET_STYLES.includes(appearance.widgetStyle)) {
            document.documentElement.setAttribute('data-bootstrap-widget-style', style);
        }
        // Pre-paint the idle opacity too, so the later async snapshot never
        // shifts it after first paint. The body class is applied later by
        // applyIdleFadeState(); only the CSS var can be set before <body> exists.
        if (appearance && typeof appearance.idleOpacity === 'number') {
            document.documentElement.style.setProperty('--idle-opacity', String(appearance.idleOpacity));
        }
    } catch (e) {
        applyWidgetStyleAttribute('crimson');
    }
})();
