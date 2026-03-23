const { app, BrowserWindow, globalShortcut, Tray, nativeImage, screen, ipcMain, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Required before app.ready: custom protocol for secure context (Speech Recognition needs this)
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

let win;
let tray;

function createWindow() {
    const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;

    win = new BrowserWindow({
        width: 900,
        height: 700,
        center: true,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        show: false,
        skipTaskbar: true,
        resizable: true,
        movable: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    win.loadURL('app://app/index.html');

    // Update tray title with efficiency %
    win.webContents.on('page-title-updated', (evt, title) => {
        evt.preventDefault();
        if (tray && title) tray.setTitle(` ${title}`);
    });

    // Open obsidian:// and other external links with system handler; hide overlay when opening externally
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('obsidian://') || url.startsWith('http://') || url.startsWith('https://')) {
            const { shell } = require('electron');
            shell.openExternal(url);
            win.hide();
        }
        return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (evt, url) => {
        if (url.startsWith('obsidian://') || url.startsWith('http://') || url.startsWith('https://')) {
            evt.preventDefault();
            const { shell } = require('electron');
            shell.openExternal(url);
            win.hide();
        }
    });

    // Hide instead of close
    win.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            win.hide();
        }
    });


}

function createTray() {
    // Create a 16x16 tray icon with a simple clock design using raw pixel data
    const iconPath = path.join(__dirname, 'tray-icon.png');
    const fs = require('fs');

    // If no custom icon, create a template image programmatically
    let icon;
    if (fs.existsSync(iconPath)) {
        icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } else {
        // Create a simple 16x16 white circle as template image
        icon = createCircleIcon();
    }
    icon.setTemplateImage(true);

    tray = new Tray(icon);
    tray.setToolTip('LocalTime');
    tray.setTitle(' --:--');

    tray.on('click', () => {
        toggleWindow();
    });
}

function createCircleIcon() {
    // Minimal 16x16 PNG with a white filled circle (template image, macOS will color it)
    // Pre-rendered as base64 PNG
    const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
        'jElEQVQ4y2P4TwRgIEYTA9GaGIjWRLQBDMRoYsCAIUCaiGgb' +
        'AmQYYGSALQ6D0DQMAmIHIjQNAWI7qCYHIjQ5AOl6NDYDKHMB' +
        'ULM9kTHgANRMVBgMAvoBxI4kRqMD1MX2JOVGIA4gNicC3UBs' +
        'GAyBugCn4Q5EarYnJR0MgYaBPanpgIGE3MhAYm4cWKcTAMPp' +
        'P0FmsFdBAAAAAElFTkSuQmCC';
    return nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'), {
        width: 16, height: 16, scaleFactor: 1.0
    });
}

function toggleWindow() {
    if (win.isVisible()) {
        win.hide();
    } else {
        win.show();
        win.focus();
    }
}

ipcMain.handle('get-login-item-settings', () => {
    return app.getLoginItemSettings().openAtLogin;
});

ipcMain.on('set-login-item-settings', (event, openAtLogin) => {
    app.setLoginItemSettings({ openAtLogin });
});

ipcMain.on('spotify-login', () => {
    const { shell } = require('electron');
    shell.openExternal('http://127.0.0.1:4004/auth');
});

ipcMain.on('open-external', (event, url) => {
    if (typeof url === 'string' && (url.startsWith('obsidian://') || url.startsWith('http://') || url.startsWith('https://'))) {
        const { shell } = require('electron');
        shell.openExternal(url);
        if (win && !win.isDestroyed()) win.hide();
    }
});

app.whenReady().then(async () => {
    protocol.handle('app', (req) => {
        const u = new URL(req.url);
        const pathname = decodeURIComponent(u.pathname) || '/index.html';
        const filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
        const resolved = path.resolve(filePath);
        const relative = path.relative(__dirname, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return new Response('Forbidden', { status: 403 });
        }
        return net.fetch(pathToFileURL(resolved).toString());
    });

    // Start proxies
    const notionProxy = require('./notion-proxy');
    await notionProxy.start();
    const gcalProxy = require('./gcal-proxy');
    await gcalProxy.start();
    const llmProxy = require('./llm-proxy');
    await llmProxy.start();
    const spotifyProxy = require('./spotify-proxy');
    await spotifyProxy.start();

    createWindow();
    createTray();

    // Global hotkey: Ctrl+Shift+T to toggle
    globalShortcut.register('Ctrl+Shift+T', () => {
        toggleWindow();
    });

    // Global hotkey: Ctrl+Shift+A to toggle and show assistant
    globalShortcut.register('Ctrl+Shift+A', () => {
        if (!win.isVisible()) {
            win.show();
        }
        win.focus();
        win.webContents.send('show-assistant');
    });
});

// Hide dock icon — pure menu bar app
app.dock?.hide();

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('before-quit', () => {
    app.isQuitting = true;
});
