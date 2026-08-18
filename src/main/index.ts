import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { type ChildProcess, spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { createServer } from 'net'
import { BrowserWindow, app, ipcMain, safeStorage, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { config as loadDotenv } from 'dotenv'
// Not `import { autoUpdater } from 'electron-updater'` — electron-updater is
// CommonJS, and Node's static named-export detection for it doesn't hold up
// once this runs as real ESM in a packaged build (works fine unpackaged/in
// dev, then throws "Named export 'autoUpdater' not found" at startup from
// inside an AppImage/asar). Default import + destructure is the reliable
// form across both.
import electronUpdaterPkg from 'electron-updater'

const { autoUpdater } = electronUpdaterPkg

// Without this, Chromium's OSCrypt backend auto-detection on Linux only
// tries libsecret/kwallet when it recognizes the desktop environment (GNOME/
// KDE via $XDG_CURRENT_DESKTOP etc.) — on anything else (Hyprland, sway, i3,
// ...) it silently falls back to no encryption at all even if a Secret
// Service daemon is running and reachable. Forcing the switch explicitly
// makes safeStorage try libsecret regardless of desktop environment. Must
// run before app.whenReady().
if (
  process.platform === 'linux' &&
  !process.argv.some((arg) => arg.startsWith('--password-store='))
) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // Electron's sandboxed preload loader can't run an ES module
      // preload script (this one is .mjs — package.json's "type":
      // "module" makes electron-vite build it that way) — contextBridge
      // never fires, window.api/window.electron end up undefined, and
      // nothing throws or logs anywhere visible. Standard electron-vite/
      // electron-toolkit fix: disable the sandbox for this window so the
      // preload's synchronous ESM import graph can actually execute.
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only hand http(s) URLs to the OS's default handler. `details.url`
    // can originate from data served by a user-configured (and
    // potentially compromised) Navidrome/Subsonic/Jellyfin server — e.g.
    // a radio station's homePageUrl — so a crafted non-http scheme
    // (file:, or a third-party protocol handler) must not reach
    // shell.openExternal, which is the exact pattern behind several
    // real Electron protocol-handler-exploitation CVEs.
    try {
      const url = new URL(details.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        shell.openExternal(details.url)
      }
    } catch {
      // Not a parseable URL — do nothing rather than risk handing a
      // malformed string to the OS shell.
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Backs the renderer's secure-storage IPC calls (see preload/index.ts and
// renderer stores/auth.ts). One JSON file in userData, each value encrypted
// via Electron's safeStorage (OS keychain/DPAPI/libsecret) when available.
// Falls back to a clearly-marked base64 encoding (not real protection, just
// avoids raw plaintext) on setups without a usable OS credential store —
// safeStorage.encryptString() throws in that case rather than failing softly.
interface StoredEntry {
  mode: 'enc' | 'plain'
  data: string
}

function secureStorageFilePath(): string {
  return join(app.getPath('userData'), 'secure-storage.json')
}

function readSecureStore(): Record<string, StoredEntry> {
  try {
    return JSON.parse(readFileSync(secureStorageFilePath(), 'utf-8'))
  } catch {
    return {}
  }
}

function writeSecureStore(store: Record<string, StoredEntry>): void {
  writeFileSync(secureStorageFilePath(), JSON.stringify(store))
}

ipcMain.handle('secure-storage:get', (_event, key: string): string | null => {
  const entry = readSecureStore()[key]
  if (!entry) return null
  const buffer = Buffer.from(entry.data, 'base64')
  return entry.mode === 'enc' ? safeStorage.decryptString(buffer) : buffer.toString('utf-8')
})

ipcMain.handle('secure-storage:set', (_event, key: string, value: string): void => {
  const store = readSecureStore()
  store[key] = safeStorage.isEncryptionAvailable()
    ? { mode: 'enc', data: safeStorage.encryptString(value).toString('base64') }
    : { mode: 'plain', data: Buffer.from(value, 'utf-8').toString('base64') }
  writeSecureStore(store)
})

ipcMain.handle('secure-storage:delete', (_event, key: string): void => {
  const store = readSecureStore()
  delete store[key]
  writeSecureStore(store)
})

// ── Bundled connect backend (packaged builds only) ──────────────────────────
//
// Dev keeps today's flow unchanged — `pnpm dev` runs connect/ separately via
// the `dev:connect` script, and readConnectDefaults() below still reads its
// .env/.connect-token the same way it always has. Rebuilding the PyInstaller
// binary on every source change would kill iteration speed, so unpackaged
// runs are never expected to spawn it themselves. A packaged build has no
// such separately-started process to rely on, so Electron spawns the bundled
// binary itself instead (see electron-builder.yml's `extraResources`, built
// by `connect/packaging/build-binary.py`).
//
// The port is resolved fresh per launch via findFreePort() below (asking the
// OS for one, rather than hardcoding 7071) so a second Beacon instance, or
// anything else already bound to 7071, can't stop this one's bundled backend
// from starting — nothing outside this process needs the port to be
// predictable, since readConnectDefaults() is the only way the renderer ever
// learns it.
let packagedConnectPort = 7071
// Generated fresh per launch — unlike connect/.connect-token (used by the
// dev flow, where the backend runs independently and needs a stable value
// across restarts), a bundled/spawned backend only ever needs to agree with
// *this* process, which already knows the value it generated.
const packagedConnectToken = randomBytes(32).toString('hex')
let connectProcess: ChildProcess | null = null

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

function startConnectServer(): void {
  const binaryName = process.platform === 'win32' ? 'connect-server.exe' : 'connect-server'
  const binaryPath = join(process.resourcesPath, 'connect-server', binaryName)
  if (!existsSync(binaryPath)) {
    console.error(`[connect] Bundled binary not found: ${binaryPath}`)
    return
  }

  connectProcess = spawn(binaryPath, [], {
    env: {
      ...process.env,
      CONNECT_TOKEN: packagedConnectToken,
      PORT: String(packagedConnectPort),
      // Persistent AirPlay pairing credentials (see connect/delivery/
      // credentials.py) — userData survives app updates, unlike the
      // packaged binary's own resources folder, which gets replaced
      // wholesale on every update.
      CONNECT_DATA_DIR: app.getPath('userData'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  connectProcess.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      if (line.trim()) console.log(`[connect] ${line.trimEnd()}`)
    }
  })
  connectProcess.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      if (line.trim()) console.error(`[connect] ${line.trimEnd()}`)
    }
  })
  connectProcess.on('error', (error) => {
    console.error('[connect] Failed to start bundled backend:', error)
  })
  connectProcess.on('exit', (code, signal) => {
    console.log(`[connect] Bundled backend exited (code=${code}, signal=${signal})`)
    connectProcess = null
  })
}

function stopConnectServer(): void {
  // Default kill() sends SIGTERM, which uvicorn (see connect/main.py)
  // already shuts down on gracefully — no separate "please stop" request
  // needed first. Idempotent — safe to call from more than one shutdown
  // hook (see the app.on() handlers below).
  connectProcess?.kill()
  connectProcess = null
}

// Learns CONNECT_TOKEN the same way the Python backend resolves it (see
// connect/core/auth.py), so the renderer never has to ask the user to type
// it in — same idea as the web/Docker build's nginx config injecting
// X-Connect-Token itself (see ng.conf.template): a trusted layer the user
// never sees knows the secret, instead of the login form asking for it.
//
// Packaged builds bypass the file-based resolution entirely: startConnectServer()
// above already generated packagedConnectToken and knows exactly which port
// it told the bundled binary to listen on. Dev keeps the original precedence:
//   1. connect/.env's CONNECT_TOKEN, if explicitly set (fixed/deployment config)
//   2. connect/.connect-token — a random token the backend generates itself
//      on first run when CONNECT_TOKEN isn't set, and persists so it's
//      stable across restarts (never a hardcoded/checked-in value, and
//      never regenerated out from under this file on every launch)
function readConnectDefaults(): { connectToken: string; connectUrl: string } {
  if (app.isPackaged) {
    return {
      connectToken: packagedConnectToken,
      connectUrl: `http://localhost:${packagedConnectPort}`,
    }
  }

  const connectDir = join(__dirname, '../../connect')
  const envPath = join(connectDir, '.env')
  const parsed = existsSync(envPath) ? (loadDotenv({ path: envPath }).parsed ?? {}) : {}
  const port = parsed.PORT || '7071'

  let connectToken = parsed.CONNECT_TOKEN ?? ''
  if (!connectToken) {
    const tokenFile = join(connectDir, '.connect-token')
    if (existsSync(tokenFile)) {
      connectToken = readFileSync(tokenFile, 'utf-8').trim()
    }
  }

  return {
    connectToken,
    connectUrl: `http://localhost:${port}`,
  }
}

ipcMain.handle('app-config:get-connect-defaults', () => readConnectDefaults())

// Checks GitHub Releases for this repo (see electron-builder.yml's `publish`
// block, which is what electron-updater reads by default) and, if a newer
// version is found, downloads it in the background and shows electron's
// native "restart to update" prompt — no custom UI needed on beacon's side.
// A no-op outside a packaged build (electron-updater looks for
// app-update.yml, which only exists in a real electron-builder output) and
// opt-out-able via DISABLE_AUTO_UPDATES for self-hosters who don't want the
// app phoning out to GitHub at all.
function checkForUpdates(): void {
  if (!app.isPackaged || process.env['DISABLE_AUTO_UPDATES']) return
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.checkForUpdatesAndNotify().catch((error) => {
    console.error('[updater] Check for updates failed:', error)
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.beacon.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  if (app.isPackaged) {
    packagedConnectPort = await findFreePort()
    startConnectServer()
  }
  createWindow()
  checkForUpdates()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// True once the quit flow below has actually started — lets the second,
// self-triggered 'before-quit' (fired by finishQuit()'s own app.quit() call)
// tell itself apart from the very first quit request and just let it
// through, instead of looping back into requestQuit() again.
let quitting = false

function finishQuit(): void {
  stopConnectServer()
  app.quit()
}

// Casting doesn't stop on its own just because this app closes — the
// backend keeps streaming to Sonos/Chromecast/DLNA/AirPlay until told
// otherwise (or until its own session-idle reaper eventually kicks in, way
// later than a user would expect). Only the renderer's connect store can
// actually stop it correctly though: doing it here would need the same
// per-login connect session id computeConnectSessionId() derives in the
// renderer (services/connect/session-id.ts) from data (server URL, user
// identity) this process has no access to — calling /stop with the wrong
// session id would silently no-op against an unrelated session instead of
// the one actually casting. So: ask the renderer, wait briefly for it to
// confirm, then tear down for real either way.
function requestQuit(): void {
  if (quitting) return
  quitting = true

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    finishQuit()
    return
  }

  let settled = false
  const finish = (): void => {
    if (settled) return
    settled = true
    finishQuit()
  }
  ipcMain.once('app:before-quit-done', finish)
  // The renderer might be slow (a device taking a moment to respond) or
  // simply gone (crashed) — don't hang app quit on it indefinitely.
  setTimeout(finish, 3000)
  win.webContents.send('app:before-quit')
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    requestQuit()
  }
})

// Covers macOS, where window-all-closed above doesn't quit the app (it stays
// resident, per OS convention) — before-quit still fires here right before
// the process actually exits. Also the second entry point once requestQuit()
// itself is already running everywhere else (its finishQuit() calling
// app.quit() re-fires this event) — the `quitting` guard lets that second
// firing proceed instead of preventing default forever.
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  requestQuit()
})

// A raw OS signal (Ctrl+C in a dev-mode terminal, or `concurrently -k`
// forwarding SIGTERM when the connect dev process exits first — see
// package.json's `dev` script) kills this process immediately via Node's
// default signal disposition. Electron's own 'before-quit'/'window-all-closed'
// above are never reached that way — those only fire for app.quit() calls
// and actual window closes, not raw signals — so without this, a dev-mode
// Ctrl+C stopped this process but left casting running on the device
// (Python does shut down cleanly on its own signal — this is specifically
// about *this* process never asking it to stop streaming first). Registering
// a handler here overrides Node's default "just die" behavior and routes
// through the exact same clean-shutdown flow instead.
process.on('SIGINT', requestQuit)
process.on('SIGTERM', requestQuit)
