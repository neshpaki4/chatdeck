const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  isApp: true,
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  copyUrl: () => ipcRenderer.invoke('action:copy-url'),
  copyText: (t) => ipcRenderer.invoke('action:copy-text', t),
  openUrl: (u) => ipcRenderer.invoke('action:open-url', u),
  openOverlay: () => ipcRenderer.send('action:open-overlay'),
  openSettings: () => ipcRenderer.send('window:settings'),
  restart: () => ipcRenderer.send('action:restart'),
  quit: () => ipcRenderer.send('app:quit'),
  settingsSaved: () => ipcRenderer.send('settings:close')
});