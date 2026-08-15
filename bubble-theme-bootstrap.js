// Apply the widget's current appearance before the bubble stylesheet paints.
// The transient bubble has its own renderer, so it cannot read the widget DOM.
(function () {
    const WIDGET_STYLES = ['crimson', 'ocean', 'aurora', 'terminal'];
    try {
        const appearance = window.bubbleApi?.getInitialAppearance?.();
        const style = WIDGET_STYLES.includes(appearance?.widgetStyle) ? appearance.widgetStyle : 'crimson';
        document.documentElement.setAttribute('data-widget-style', style);
    } catch (e) {
        document.documentElement.setAttribute('data-widget-style', 'crimson');
    }
})();
