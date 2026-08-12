import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { type ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { BrowserWindow, app, ipcMain, safeStorage, shell } from 'electron';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { config as loadDotenv } from 'dotenv';
// Not `import { autoUpdater } from 'electron-updater'` — electron-updater is
// CommonJS, and Node's static named-export detection for it doesn't hold up
// once this runs as real ESM in a packaged build (works fine unpackaged/in
// dev, then throws "Named export 'autoUpdater' not found" at startup from
// inside an AppImage/asar). Default import + destructure is the reliable
// form across both.
import electronUpdaterPkg from 'electron-updater';

const { autoUpdater } = electronUpdaterPkg;

// Without this, Chromium's OSCrypt backend auto-detection on Linux only
// tries libsecret/kwallet when it recognizes the desktop environment (GNOME/
// KDE via $XDG_CURRENT_DESKTOP etc.) — on anything else (Hyprland, sway, i3,
// ...) it silently falls back to no encryption at all even if a Secret
// Service daemon is running and reachable. Forcing the switch explicitly
// makes safeStorage try libsecret regardless of desktop environment. Must
// run before app.whenReady(). Same fix as the upstream Feishin fork uses.
if (process.platform === 'linux' && !process.argv.some((arg) => arg.startsWith('--password-store='))) {
    app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

function createWindow(): void {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: join(__dirname, '../preload/index.mjs'),
            sandbox: false,
        },
    });

    mainWindow.on('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url);
        return { action: 'deny' };
    });

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }
}

// Backs the renderer's secure-storage IPC calls (see preload/index.ts and
// renderer stores/auth.ts). One JSON file in userData, each value encrypted
// via Electron's safeStorage (OS keychain/DPAPI/libsecret) when available.
// Falls back to a clearly-marked base64 encoding (not real protection, just
// avoids raw plaintext) on setups without a usable OS credential store —
// safeStorage.encryptString() throws in that case rather than failing softly.
interface StoredEntry {
    mode: 'enc' | 'plain';
    data: string;
}

function secureStorageFilePath(): string {
    return join(app.getPath('userData'), 'secure-storage.json');
}

function readSecureStore(): Record<string, StoredEntry> {
    try {
        return JSON.parse(readFileSync(secureStorageFilePath(), 'utf-8'));
    } catch {
        return {};
    }
}

function writeSecureStore(store: Record<string, StoredEntry>): void {
    writeFileSync(secureStorageFilePath(), JSON.stringify(store));
}

ipcMain.handle('secure-storage:get', (_event, key: string): string | null => {
    const entry = readSecureStore()[key];
    if (!entry) return null;
    const buffer = Buffer.from(entry.data, 'base64');
    return entry.mode === 'enc' ? safeStorage.decryptString(buffer) : buffer.toString('utf-8');
});

ipcMain.handle('secure-storage:set', (_event, key: string, value: string): void => {
    const store = readSecureStore();
    store[key] = safeStorage.isEncryptionAvailable()
        ? { mode: 'enc', data: safeStorage.encryptString(value).toString('base64') }
        : { mode: 'plain', data: Buffer.from(value, 'utf-8').toString('base64') };
    writeSecureStore(store);
});

ipcMain.handle('secure-storage:delete', (_event, key: string): void => {
    const store = readSecureStore();
    delete store[key];
    writeSecureStore(store);
});

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
const PACKAGED_CONNECT_PORT = 9181;
// Generated fresh per launch — unlike connect/.connect-token (used by the
// dev flow, where the backend runs independently and needs a stable value
// across restarts), a bundled/spawned backend only ever needs to agree with
// *this* process, which already knows the value it generated.
const packagedConnectToken = randomBytes(32).toString('hex');
let connectProcess: ChildProcess | null = null;

function startConnectServer(): void {
    const binaryName = process.platform === 'win32' ? 'connect-server.exe' : 'connect-server';
    const binaryPath = join(process.resourcesPath, 'connect-server', binaryName);
    if (!existsSync(binaryPath)) {
        console.error(`[connect] Bundled binary not found: ${binaryPath}`);
        return;
    }

    connectProcess = spawn(binaryPath, [], {
        env: {
            ...process.env,
            CONNECT_TOKEN: packagedConnectToken,
            PORT: String(PACKAGED_CONNECT_PORT),
            // Persistent AirPlay pairing credentials (see connect/delivery/
            // credentials.py) — userData survives app updates, unlike the
            // packaged binary's own resources folder, which gets replaced
            // wholesale on every update.
            CONNECT_DATA_DIR: app.getPath('userData'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    connectProcess.stdout?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
            if (line.trim()) console.log(`[connect] ${line.trimEnd()}`);
        }
    });
    connectProcess.stderr?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
            if (line.trim()) console.error(`[connect] ${line.trimEnd()}`);
        }
    });
    connectProcess.on('error', (error) => {
        console.error('[connect] Failed to start bundled backend:', error);
    });
    connectProcess.on('exit', (code, signal) => {
        console.log(`[connect] Bundled backend exited (code=${code}, signal=${signal})`);
        connectProcess = null;
    });
}

function stopConnectServer(): void {
    // Default kill() sends SIGTERM, which uvicorn (see connect/main.py)
    // already shuts down on gracefully — no separate "please stop" request
    // needed first. Idempotent — safe to call from more than one shutdown
    // hook (see the app.on() handlers below).
    connectProcess?.kill();
    connectProcess = null;
}

// Learns CONNECT_TOKEN the same way the Python backend resolves it (see
// connect/core/auth.py), so the renderer never has to ask the user to type
// it in — mirrors how the upstream Feishin fork's nginx config injects
// X-Connect-Token itself for the web/Docker build (see ng.conf.template): a
// trusted layer the user never sees knows the secret, instead of the login
// form asking for it.
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
            connectUrl: `http://localhost:${PACKAGED_CONNECT_PORT}`,
        };
    }

    const connectDir = join(__dirname, '../../connect');
    const envPath = join(connectDir, '.env');
    const parsed = existsSync(envPath) ? (loadDotenv({ path: envPath }).parsed ?? {}) : {};
    const port = parsed.PORT || '9181';

    let connectToken = parsed.CONNECT_TOKEN ?? '';
    if (!connectToken) {
        const tokenFile = join(connectDir, '.connect-token');
        if (existsSync(tokenFile)) {
            connectToken = readFileSync(tokenFile, 'utf-8').trim();
        }
    }

    return {
        connectToken,
        connectUrl: `http://localhost:${port}`,
    };
}

ipcMain.handle('app-config:get-connect-defaults', () => readConnectDefaults());

// Checks GitHub Releases for this repo (see electron-builder.yml's `publish`
// block, which is what electron-updater reads by default) and, if a newer
// version is found, downloads it in the background and shows electron's
// native "restart to update" prompt — no custom UI needed on beacon's side.
// A no-op outside a packaged build (electron-updater looks for
// app-update.yml, which only exists in a real electron-builder output) and
// opt-out-able via DISABLE_AUTO_UPDATES for self-hosters who don't want the
// app phoning out to GitHub at all.
function checkForUpdates(): void {
    if (!app.isPackaged || process.env['DISABLE_AUTO_UPDATES']) return;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
        console.error('[updater] Check for updates failed:', error);
    });
}

app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.beacon.app');

    app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window);
    });

    if (app.isPackaged) startConnectServer();
    createWindow();
    checkForUpdates();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        stopConnectServer();
        app.quit();
    }
});

// Covers macOS, where window-all-closed above doesn't quit the app (it stays
// resident, per OS convention) — before-quit still fires exactly once right
// before the process actually exits there. Harmless to also fire on other
// platforms (stopConnectServer() is idempotent); it's already been called
// once by the time app.quit() above gets here.
app.on('before-quit', stopConnectServer);
