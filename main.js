const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const { createChatServer } = require('./server');
const { makeIcon } = require('./icon');

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let chatServer = null;
let quitting = false;
let lastTrayKey = '';

if (!app.requestSingleInstanceLock()) {
  app.whenReady().then(() => {
    dialog.showMessageBox({
      type: 'warning',
      title: 'ChatDeck Legacy',
      message: 'Приложение уже запущено',
      detail:
        'Работает другой экземпляр ChatDeck Legacy — одновременно может быть запущен только один.\n\n' +
        'Скорее всего окно свёрнуто в системный трей (закрытие окна не завершает программу). ' +
        'Найдите фиолетовую иконку рядом с часами.',
      buttons: ['Понятно'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      icon: nativeImage.createFromBuffer(makeIcon(128))
    }).then(() => {
      app.quit();
    });
  });
} else {
  // Первый экземпляр: отклик на чужую попытку запуска
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
    mainWindow.flashFrame(true);
  });

  app.whenReady().then(async () => {
    chatServer = createChatServer({
      configPath: path.join(app.getPath('userData'), 'config.json')
    });

    try {
      await chatServer.start();
    } catch (e) {
      console.error('[Server] Start failed:', e.message);
    }

    createMainWindow();
    createTray();
    startStateLoop();

    app.on('activate', () => { if (mainWindow) mainWindow.show(); });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && quitting) app.quit();
  });

  // Аккуратный выход
  let isShuttingDown = false;
  app.on('before-quit', (e) => {
    if (!isShuttingDown && chatServer) {
      e.preventDefault();
      isShuttingDown = true;
      chatServer.shutdown().finally(() => app.quit());
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 560,
    minWidth: 400,
    minHeight: 500,
    maxWidth: 560,
    maxHeight: 700,
    title: 'ChatDeck Legacy',
    icon: nativeImage.createFromBuffer(makeIcon(128)),
    backgroundColor: '#0d0d11',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'panel', 'panel.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (!quitting) { e.preventDefault(); mainWindow.hide(); }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(makeIcon(32)));
  tray.setToolTip('ChatDeck Legacy');
  tray.on('double-click', () => mainWindow.show());
  rebuildTray();
}

function rebuildTray() {
  const st = chatServer.getState();
  const key = `${st.chatConnected}|${st.channel}|${st.port}|${st.streamLive}`;
  if (key === lastTrayKey) return;
  lastTrayKey = key;

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: st.chatConnected ? (st.streamLive ? `В эфире: #${st.channel}` : `Чат: #${st.channel} (офлайн)`) : 'Не подключено', enabled: false },
    { type: 'separator' },
    { label: 'Показать панель', click: () => mainWindow.show() },
    { label: 'Скопировать URL для OBS', click: () => clipboard.writeText(st.obsUrl) },
    { label: 'Настройки', click: openSettings },
    { label: 'Перезапустить чат', click: () => chatServer.reconnect() },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } }
  ]));
}

function startStateLoop() {
  setInterval(() => {
    if (!chatServer) return;
    rebuildTray();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.webContents.send('state', chatServer.getState());
    }
  }, 1000);
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
  const st = chatServer.getState();
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 520,
    resizable: false,
    title: 'Настройки — ChatDeck Legacy',
    icon: nativeImage.createFromBuffer(makeIcon(128)),
    backgroundColor: '#0e0e10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.loadURL(`${st.obsUrl}/setup.html`);
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ==================== IPC ====================

ipcMain.handle('state:get', () => chatServer.getState());
ipcMain.handle('action:copy-url', () => {
  clipboard.writeText(chatServer.getState().obsUrl);
  return true;
});
ipcMain.on('action:open-overlay', () => shell.openExternal(chatServer.getState().obsUrl));
ipcMain.on('action:restart', () => chatServer.reconnect());
ipcMain.on('window:settings', openSettings);
ipcMain.on('settings:close', () => { if (settingsWindow) settingsWindow.close(); });
ipcMain.on('app:quit', () => { quitting = true; app.quit(); });
ipcMain.handle('action:copy-text', (_e, text) => {
  clipboard.writeText(String(text == null ? '' : text));
  return true;
});
ipcMain.handle('action:open-url', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  return true;
});
