const { app, BrowserWindow, globalShortcut, Tray, nativeImage, screen } = require('electron');
const path = require('path');

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
            contextIsolation: true
        }
    });

    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Load dashboard from local file
    win.loadFile(path.join(__dirname, 'index.html'));

    // Update tray title with efficiency %
    win.webContents.on('page-title-updated', (evt, title) => {
        evt.preventDefault();
        if (tray && title) tray.setTitle(` ${title}`);
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
    tray.setTitle(' --%');

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

app.whenReady().then(() => {
    createWindow();
    createTray();

    // Global hotkey: Ctrl+Shift+T to toggle
    globalShortcut.register('Ctrl+Shift+T', () => {
        toggleWindow();
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
