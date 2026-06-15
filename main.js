const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');

const NETWORK_DIR = '\\\\192.168.1.249\\Kalite10$\\PlanlamaData';
const DATA_FILE = path.join(NETWORK_DIR, 'data.json');
const TMP_FILE = path.join(NETWORK_DIR, 'data.tmp');
const LOCK_FILE = path.join(NETWORK_DIR, 'planlama.lock');
const BACKUP_DIR = path.join(NETWORK_DIR, 'backups');
const MAX_BACKUPS = 30;

const LOCAL_BACKUP_DIR = 'C:\\apps\\casting-planner\\planner\\PlanlamaData2\\backups';
const MAX_LOCAL_BACKUPS = 30;

const LOCK_EXPIRY_MS = 12 * 60 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 4000;

let mainWindow = null;
let lockAcquired = false;

function getUsername() { return os.userInfo().username || 'bilinmeyen'; }
function getHostname() { return os.hostname() || 'bilinmeyen'; }

// Zaman aşımlı async ağ erişim kontrolü
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
}

async function isNetworkAvailable() {
    try {
        await withTimeout(fsp.access(NETWORK_DIR, fs.constants.F_OK), NETWORK_TIMEOUT_MS);
        return true;
    } catch {
        return false;
    }
}

async function readLockInfo() {
    try {
        const content = await withTimeout(fsp.readFile(LOCK_FILE, 'utf8'), NETWORK_TIMEOUT_MS);
        return JSON.parse(content);
    } catch {
        return null;
    }
}

async function writeLock() {
    try {
        const info = { username: getUsername(), hostname: getHostname(), time: new Date().toISOString() };
        await withTimeout(fsp.writeFile(LOCK_FILE, JSON.stringify(info, null, 2), 'utf8'), NETWORK_TIMEOUT_MS);
        lockAcquired = true;
        return true;
    } catch {
        return false;
    }
}

async function releaseLock() {
    if (!lockAcquired) return;
    try {
        const info = await readLockInfo();
        if (info && info.username === getUsername() && info.hostname === getHostname()) {
            await withTimeout(fsp.unlink(LOCK_FILE), NETWORK_TIMEOUT_MS);
        }
    } catch { /* ignore */ }
    lockAcquired = false;
}

function releaseLockSync() {
    if (!lockAcquired) return;
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const content = fs.readFileSync(LOCK_FILE, 'utf8');
            const info = JSON.parse(content);
            if (info && info.username === getUsername() && info.hostname === getHostname()) {
                fs.unlinkSync(LOCK_FILE);
            }
        }
    } catch { /* ignore */ }
    lockAcquired = false;
}

async function checkAndAcquireLock() {
    const existing = await readLockInfo();
    if (existing) {
        const lockTime = new Date(existing.time).getTime();
        if (Date.now() - lockTime < LOCK_EXPIRY_MS) {
            if (existing.username !== getUsername() || existing.hostname !== getHostname()) {
                return { ok: false, reason: 'locked', info: existing };
            }
        }
    }
    const wrote = await writeLock();
    if (!wrote) return { ok: false, reason: 'lock_write_failed' };
    return { ok: true };
}

async function rotateBackups() {
    try {
        await fsp.mkdir(BACKUP_DIR, { recursive: true });
        const files = (await withTimeout(fsp.readdir(BACKUP_DIR), NETWORK_TIMEOUT_MS))
            .filter(f => f.startsWith('data_') && f.endsWith('.json'))
            .sort();
        while (files.length >= MAX_BACKUPS) {
            await withTimeout(fsp.unlink(path.join(BACKUP_DIR, files.shift())), NETWORK_TIMEOUT_MS);
        }
    } catch { /* ignore */ }
}

async function createBackup(stamp) {
    try {
        await rotateBackups();
        const backupFile = path.join(BACKUP_DIR, `data_${stamp}.json`);
        await withTimeout(fsp.copyFile(DATA_FILE, backupFile), NETWORK_TIMEOUT_MS);

        // Yerel güvenlik yedeği — sadece yazma, otomatik okunmaz
        try {
            await fsp.mkdir(LOCAL_BACKUP_DIR, { recursive: true });
            const localFiles = (await fsp.readdir(LOCAL_BACKUP_DIR))
                .filter(f => f.startsWith('data_') && f.endsWith('.json'))
                .sort();
            while (localFiles.length >= MAX_LOCAL_BACKUPS) {
                await fsp.unlink(path.join(LOCAL_BACKUP_DIR, localFiles.shift()));
            }
            await fsp.copyFile(DATA_FILE, path.join(LOCAL_BACKUP_DIR, `data_${stamp}.json`));
        } catch { /* yerel yedek hatası ana akışı etkilemez */ }
    } catch { /* ignore */ }
}

async function atomicWrite(jsonString) {
    await withTimeout(fsp.writeFile(TMP_FILE, jsonString, 'utf8'), NETWORK_TIMEOUT_MS);
    await withTimeout(fsp.rename(TMP_FILE, DATA_FILE), NETWORK_TIMEOUT_MS);
}

function makeStamp() {
    return new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
}

// IPC: load data from network
ipcMain.handle('network-load', async () => {
    if (!await isNetworkAvailable()) return { ok: false, reason: 'network_unavailable' };
    try {
        const content = await withTimeout(fsp.readFile(DATA_FILE, 'utf8'), NETWORK_TIMEOUT_MS);
        return { ok: true, data: JSON.parse(content) };
    } catch (err) {
        if (err.code === 'ENOENT') return { ok: true, data: null };
        return { ok: false, reason: 'read_error', message: err.message };
    }
});

// IPC: save data to network
ipcMain.handle('network-save', async (event, data) => {
    if (!await isNetworkAvailable()) return { ok: false, reason: 'network_unavailable' };
    const lockResult = await checkAndAcquireLock();
    if (!lockResult.ok) return lockResult;
    try {
        const stamp = makeStamp();
        // Önce mevcut dosya var mı kontrol et (yedek için)
        try { await fsp.access(DATA_FILE); await createBackup(stamp); } catch { /* ilk kayıt */ }
        await atomicWrite(JSON.stringify(data, null, 2));
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: 'write_error', message: err.message };
    }
});

// IPC: get network status
ipcMain.handle('network-status', async () => {
    const available = await isNetworkAvailable();
    if (!available) return { available: false };
    const lock = await readLockInfo();
    return { available: true, lock, myUsername: getUsername(), myHostname: getHostname() };
});

// IPC: release lock manually
ipcMain.handle('network-release-lock', async () => {
    await releaseLock();
    return { ok: true };
});

// IPC: list backups
ipcMain.handle('network-list-backups', async () => {
    if (!await isNetworkAvailable()) return { ok: false, reason: 'network_unavailable' };
    try {
        await fsp.mkdir(BACKUP_DIR, { recursive: true });
        const files = (await withTimeout(fsp.readdir(BACKUP_DIR), NETWORK_TIMEOUT_MS))
            .filter(f => f.startsWith('data_') && f.endsWith('.json'))
            .sort()
            .reverse();
        return { ok: true, backups: files };
    } catch (err) {
        return { ok: false, reason: 'read_error', message: err.message };
    }
});

// IPC: load specific backup
ipcMain.handle('network-load-backup', async (event, filename) => {
    if (!await isNetworkAvailable()) return { ok: false, reason: 'network_unavailable' };
    try {
        const safeName = path.basename(filename);
        const filePath = path.join(BACKUP_DIR, safeName);
        const content = await withTimeout(fsp.readFile(filePath, 'utf8'), NETWORK_TIMEOUT_MS);
        return { ok: true, data: JSON.parse(content) };
    } catch (err) {
        if (err.code === 'ENOENT') return { ok: false, reason: 'not_found' };
        return { ok: false, reason: 'read_error', message: err.message };
    }
});

// IPC: report penceresini aç (temp dosya üzerinden)
ipcMain.handle('open-report-window', async (event, html) => {
    const tmpPath = path.join(os.tmpdir(), 'casting_plan_report.html');
    const baseHref = 'file:///' + __dirname.replace(/\\/g, '/') + '/';
    html = html.replace('<head>', `<head><base href="${baseHref}">`);
    await fsp.writeFile(tmpPath, html, 'utf8');
    const win = new BrowserWindow({
        width: 1020,
        height: 860,
        title: 'Üretim Planı',
        icon: path.join(__dirname, 'kenan-metal-logo.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    win.loadFile(tmpPath);
    Menu.setApplicationMenu(null);
});

// IPC: mevcut pencereyi yazdır (webContents.print ile)
ipcMain.handle('print-current-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        win.webContents.print({ silent: false, printBackground: true }, (success, errorType) => {
            if (!success && errorType !== 'cancelled') console.error('Print error:', errorType);
        });
    }
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 900,
        minHeight: 600,
        icon: path.join(__dirname, 'kenan-metal-logo.png'),
        title: 'Kenan Metal - Döküm Planlayıcı',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
        backgroundColor: '#f0f4f8',
    });

    mainWindow.maximize();
    mainWindow.loadFile('index.html');
    Menu.setApplicationMenu(null);
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('before-quit', () => { releaseLockSync(); });
app.on('window-all-closed', () => {
    releaseLockSync();
    if (process.platform !== 'darwin') app.quit();
});
