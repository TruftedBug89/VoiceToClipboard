// src/main/tray.js
// System tray icon and dynamic context menu management.

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadConfig, getUiLanguage } = require('./config-store');
const { L } = require('./i18n');

let tray = null;

function trayMenuForState(alwaysOnTop, callbacks) {
    const lang = getUiLanguage();
    return Menu.buildFromTemplate([
        {
            label: L('tray.toggle', null, lang),
            click: () => callbacks.onToggleRecording?.()
        },
        {
            label: L('tray.resetPosition', null, lang),
            click: () => callbacks.onResetPosition?.()
        },
        {
            label: L('tray.settings', null, lang),
            click: () => callbacks.onShowSettings?.()
        },
        { type: 'separator' },
        {
            label: L('tray.alwaysOnTop', null, lang),
            type: 'checkbox',
            checked: alwaysOnTop,
            click: item => callbacks.onAlwaysOnTopChange?.(item.checked)
        },
        { type: 'separator' },
        {
            label: L('tray.quit', null, lang),
            click: () => callbacks.onQuit ? callbacks.onQuit() : app.quit()
        }
    ]);
}

function createTray(callbacks = {}) {
    const iconPath = path.join(__dirname, '../../build/icon.ico');
    let icon;
    if (fs.existsSync(iconPath)) {
        icon = nativeImage.createFromPath(iconPath);
    } else {
        const iconBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACYSURBVDhPzZExDsMgDEVf6tCld+m+U0+To0TkAhUjy5ZIVUq/xI/tf3ADcM49+oA7Y/5hF5i71oO5G+269wP4jPntA0Tkg1Kq/wNEpAFKqQ9O1wZ8YEqzT9cGTFA3+3RtwAR1s0/XBkxQN/t0bcAER6v26dqACeq2eBtw07X/B1y/G/A13QGk688BpOv/Ac492gE24D70BUt0i16n37dGAAAAAElFTkSuQmCC';
        icon = nativeImage.createFromDataURL('data:image/png;base64,' + iconBase64);
    }
    tray = new Tray(icon);
    const lang = getUiLanguage();
    tray.setToolTip(L('tray.tooltip', null, lang));

    tray.setContextMenu(trayMenuForState(loadConfig().alwaysOnTop !== false, callbacks));

    const toggleWindow = () => callbacks.onToggleWindow?.();
    tray.on('click', toggleWindow);
    tray.on('double-click', toggleWindow);

    return tray;
}

function updateTrayMenu(callbacks = {}) {
    if (tray) {
        const lang = getUiLanguage();
        tray.setToolTip(L('tray.tooltip', null, lang));
        tray.setContextMenu(trayMenuForState(loadConfig().alwaysOnTop !== false, callbacks));
    }
}

function destroyTray() {
    if (tray) {
        tray.destroy();
        tray = null;
    }
}

module.exports = {
    createTray,
    updateTrayMenu,
    destroyTray,
    get tray() { return tray; }
};
