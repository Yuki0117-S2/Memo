const { app, BrowserWindow } = require('electron');
const path = require('path');
const express = require('express');

const PORT = 37642;
let server = null;

// Windows 작업표시줄 아이콘 고정
if (process.platform === 'win32') {
  app.setAppUserModelId('com.kyeoul.memohub');
}

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const web = express();

    // 현재 폴더의 html/js/css/png 등을 정적 파일로 제공
    web.use(express.static(__dirname));

    server = web.listen(PORT, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${PORT}`);
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}

async function createWindow() {
  const baseUrl = await startLocalServer();

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 600,
    minHeight: 500,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'icon.png'),
    title: 'Memo Hub',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(`${baseUrl}/index.html`);

  // 필요하면 개발 중에만 켜기
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow().catch((err) => {
    console.error(err);
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (server) server.close();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (server) server.close();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((err) => {
      console.error(err);
    });
  }
});