const { app, BrowserWindow, globalShortcut, Tray, nativeImage } = require('electron');
const path = require('path');

let win;
let tray;

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 750,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    show: false, // Starts hidden until you press your hotkey or click the tray
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  
  // Ensures the dashboard floats over full-screen Mac apps
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');

  // --- THE LOGIC BRIDGE ---
  // Listens for the HTML file changing the document title, then pushes it to the Tray
  win.on('page-title-updated', (evt, title) => {
    evt.preventDefault(); // Stops the actual window title bar from changing
    if (tray) {
      tray.setTitle(title);
    }
  });
}

function createTray() {
  // Generates a transparent 16x16 pixel on the fly to act as the image anchor
  const emptyIcon = nativeImage.createEmpty();
  emptyIcon.resize({ width: 16, height: 16 });
  
  tray = new Tray(emptyIcon);
  
  tray.setToolTip('LocalTime Dashboard');
  tray.setTitle('--%'); // Default placeholder before Python connects

  // Clicking the score in the menu bar toggles the dashboard
  tray.on('click', () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // Your global hotkey
  globalShortcut.register('Ctrl+Shift+T', () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
});

// Clean up background resources when quitting
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});