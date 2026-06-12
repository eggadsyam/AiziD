const { app, BrowserWindow } = require('electron')
const path = require('path')
const { spawn } = require('child_process')

let pyProc = null

function startBackendSubprocess() {
  const dbPath = path.join(app.getPath('userData'), 'database.db').replace(/\\/g, '/')
  const serverPath = path.join(__dirname, '..', 'server.js')
  
  pyProc = spawn(process.execPath, [serverPath], {
    env: { 
      ...process.env, 
      ELECTRON_RUN_AS_NODE: '1',
      PORT: '5050',
      DATABASE_URL: `sqlite:///${dbPath}`
    }
  })

  pyProc.stdout.on('data', (data) => {
    console.log(`Backend stdout: ${data.toString()}`);
  })

  pyProc.stderr.on('data', (data) => {
    console.error(`Backend stderr: ${data.toString()}`);
  })
}

function stopBackendSubprocess() {
  if (pyProc !== null) {
    pyProc.kill()
    pyProc = null
  }
}

function createWindow () {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    title: 'AiziD — Drive Aggregator'
  })

  const targetUrl = 'http://localhost:5050'
  
  // Tangani kegagalan load jika Flask belum selesai booting
  mainWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.loadURL(targetUrl).catch(() => {})
      }
    }, 500)
  })

  mainWindow.loadURL(targetUrl).catch(() => {})

  mainWindow.setMenuBarVisibility(false)
}

app.whenReady().then(() => {
  startBackendSubprocess()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', function () {
  stopBackendSubprocess()
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', function () {
  stopBackendSubprocess()
})
