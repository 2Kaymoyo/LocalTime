const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getLoginItemSettings: () => ipcRenderer.invoke('get-login-item-settings'),
    setLoginItemSettings: (openAtLogin) => ipcRenderer.send('set-login-item-settings', openAtLogin),
    onShowAssistant: (callback) => ipcRenderer.on('show-assistant', () => callback()),
    openExternal: (url) => ipcRenderer.send('open-external', url)
});

contextBridge.exposeInMainWorld('spotifyAPI', {
    login: () => {
        ipcRenderer.send('spotify-login');
    },
    getStatus: async () => {
        try {
            const res = await fetch('http://127.0.0.1:4004/status');
            return await res.json();
        } catch (e) { return null; }
    },
    getPlayer: async () => {
        try {
            const res = await fetch('http://127.0.0.1:4004/api/player');
            return await res.json();
        } catch (e) { return null; }
    },
    play: async () => fetch('http://127.0.0.1:4004/api/player/play', { method: 'PUT' }),
    pause: async () => fetch('http://127.0.0.1:4004/api/player/pause', { method: 'PUT' }),
    next: async () => fetch('http://127.0.0.1:4004/api/player/next', { method: 'POST' }),
    previous: async () => fetch('http://127.0.0.1:4004/api/player/previous', { method: 'POST' })
});
