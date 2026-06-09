const { app, BrowserWindow } = require('electron');
const path = require('path');

// Windows 작업표시줄 아이콘 정확히 박히게 (이거 없으면 가끔 Electron 기본 아이콘 뜸)
if (process.platform === 'win32') {
  app.setAppUserModelId('com.kyeoul.memohub');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 600,
    minHeight: 500,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'icon.png'),
    title: 'Memo Hub',
    autoHideMenuBar: true, // 메뉴바 자동 숨김 (Alt 누르면 보임)
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');

  // 개발용: F12 누르면 DevTools 열림 (필요 없으면 주석 처리)
  // win.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
