const { app, BrowserWindow, Menu, ipcMain, shell, dialog, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const crypto = require('crypto');

const NETWORK_DIR = '\\\\192.168.1.249\\Kalite10$\\PlanlamaData';
const DATA_FILE = path.join(NETWORK_DIR, 'data.json');
const TMP_FILE = path.join(NETWORK_DIR, 'data.tmp');
const LOCK_FILE = path.join(NETWORK_DIR, 'planlama.lock');
const BACKUP_DIR = path.join(NETWORK_DIR, 'backups');
const MAX_BACKUPS = 30;

const LOCAL_BACKUP_DIR = 'C:\\apps\\casting-planner\\planner\\PlanlamaData2\\backups';
const MAX_LOCAL_BACKUPS = 30;

const LOCK_LEASE_MS = 90 * 1000;
const LOCK_HEARTBEAT_MS = 20 * 1000;
const LEGACY_LOCK_EXPIRY_MS = 7 * 60 * 1000;
const INCOMPLETE_LOCK_GRACE_MS = 10 * 1000;
const NETWORK_TIMEOUT_MS = 4000;
const CLOUD_TIMEOUT_MS = 10000;
const CLOUD_CONFIG_FILES = [
    path.join(app.getPath('userData'), 'cloud-plan.config.json'),
    path.join(__dirname, 'cloud-plan.config.json'),
];

let mainWindow = null;
let lockAcquired = false;
let lockHeartbeatTimer = null;
const lockToken = crypto.randomUUID();

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

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
    let created = false;
    try {
        const now = new Date().toISOString();
        const info = {
            version: 2,
            token: lockToken,
            username: getUsername(),
            hostname: getHostname(),
            time: now,
            leaseMs: LOCK_LEASE_MS,
        };
        await withTimeout(fsp.writeFile(
            LOCK_FILE,
            JSON.stringify(info, null, 2),
            { encoding: 'utf8', flag: 'wx' }
        ), NETWORK_TIMEOUT_MS);
        created = true;
        lockAcquired = true;
        startLockHeartbeat();
        return true;
    } catch (error) {
        // Bazı SMB paylaşımlarında dosya oluşturulup içerik yazılamazsa boş kilit kalabilir.
        // Yalnızca bu denemede oluşmuş sıfır baytlık dosyayı temizle.
        if (!created && error && error.code !== 'EEXIST') {
            try {
                const stat = await fsp.stat(LOCK_FILE);
                if (stat.size === 0) await fsp.unlink(LOCK_FILE);
            } catch { /* temizlenecek dosya yok */ }
        }
        return false;
    }
}

async function releaseLock() {
    if (!lockAcquired) return;
    stopLockHeartbeat();
    try {
        const info = await readLockInfo();
        if (info && info.token === lockToken) {
            await withTimeout(fsp.unlink(LOCK_FILE), NETWORK_TIMEOUT_MS);
        }
    } catch { /* ignore */ }
    lockAcquired = false;
}

function releaseLockSync() {
    if (!lockAcquired) return;
    stopLockHeartbeat();
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const content = fs.readFileSync(LOCK_FILE, 'utf8');
            const info = JSON.parse(content);
            if (info && info.token === lockToken) {
                fs.unlinkSync(LOCK_FILE);
            }
        }
    } catch { /* ignore */ }
    lockAcquired = false;
}

async function checkAndAcquireLock() {
    if (lockAcquired) return { ok: true };
    return { ok: false, reason: 'lock_lost', info: await readLockInfo() };
}

function lockOwnerText(info) {
    if (!info || typeof info !== 'object') return 'Kullanıcı bilgisi okunamadı.';
    const lines = [];
    if (info.username) lines.push(`Kullanıcı: ${info.username}`);
    if (info.hostname) lines.push(`Bilgisayar: ${info.hostname}`);
    if (info.time) lines.push(`Açılış zamanı: ${new Date(info.time).toLocaleString('tr-TR')}`);
    return lines.length ? lines.join('\n') : 'Kullanıcı bilgisi okunamadı.';
}

function stopLockHeartbeat() {
    if (lockHeartbeatTimer) clearInterval(lockHeartbeatTimer);
    lockHeartbeatTimer = null;
}

function startLockHeartbeat() {
    stopLockHeartbeat();
    lockHeartbeatTimer = setInterval(async () => {
        if (!lockAcquired) return;
        try {
            const info = await readLockInfo();
            if (!info || info.token !== lockToken) {
                lockAcquired = false;
                stopLockHeartbeat();
                return;
            }
            const now = new Date();
            await withTimeout(fsp.utimes(LOCK_FILE, now, now), NETWORK_TIMEOUT_MS);
        } catch { /* sonraki heartbeat tekrar dener */ }
    }, LOCK_HEARTBEAT_MS);
}

async function acquireApplicationLock() {
    if (!await isNetworkAvailable()) {
        dialog.showErrorBox(
            'Ağ bağlantısı yok',
            'Döküm Planlayıcı ortak ağ klasörüne ulaşamadığı için açılamıyor.\n\nAğ bağlantısını kontrol edip yeniden deneyin.'
        );
        return false;
    }

    let lockStat = null;
    let existing = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try { lockStat = await withTimeout(fsp.stat(LOCK_FILE), NETWORK_TIMEOUT_MS); } catch { lockStat = null; }
        existing = lockStat ? await readLockInfo() : null;
        if (!lockStat || existing) break;
        const ageMs = Date.now() - lockStat.mtimeMs;
        if (ageMs >= INCOMPLETE_LOCK_GRACE_MS) break;
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    if (existing) {
        const lockTime = lockStat && Number.isFinite(lockStat.mtimeMs)
            ? lockStat.mtimeMs
            : new Date(existing.time).getTime();
        const expiryMs = existing.version === 2 && existing.token
            ? LOCK_LEASE_MS
            : LEGACY_LOCK_EXPIRY_MS;
        const isStale = !Number.isFinite(lockTime) || Date.now() - lockTime >= expiryMs;
        if (!isStale) {
            dialog.showErrorBox(
                'Döküm Planlayıcı kullanımda',
                `Uygulama şu anda başka bir bilgisayarda açık.\n\n${lockOwnerText(existing)}`
            );
            return false;
        }
        try {
            await withTimeout(fsp.unlink(LOCK_FILE), NETWORK_TIMEOUT_MS);
            lockStat = null;
            existing = null;
        } catch (error) {
            if (!error || error.code !== 'ENOENT') {
                dialog.showErrorBox('Kilit temizlenemedi', String(error));
                return false;
            }
        }
    } else if (lockStat) {
        const ageMs = Date.now() - lockStat.mtimeMs;
        if (ageMs < INCOMPLETE_LOCK_GRACE_MS) {
            dialog.showErrorBox(
                'Döküm Planlayıcı başlatılıyor',
                'Başka bir bilgisayar kilidi oluşturuyor olabilir. Birkaç saniye sonra yeniden deneyin.'
            );
            return false;
        }
        try {
            await withTimeout(fsp.unlink(LOCK_FILE), NETWORK_TIMEOUT_MS);
        } catch (error) {
            if (!error || error.code !== 'ENOENT') {
                dialog.showErrorBox('Bozuk kilit temizlenemedi', String(error));
                return false;
            }
        }
    }

    if (!await writeLock()) {
        const current = await readLockInfo();
        dialog.showErrorBox(
            'Döküm Planlayıcı kullanımda',
            `Kilit oluşturulamadı. Uygulama başka bir bilgisayarda açılmış olabilir.\n\n${lockOwnerText(current)}`
        );
        return false;
    }
    return true;
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
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function readCloudConfig() {
    const envUrl = String(process.env.CASTING_PLAN_CLOUD_URL || '').trim();
    const envToken = String(process.env.CASTING_PLAN_UPLOAD_TOKEN || '').trim();
    if (envUrl && envToken) {
        return { url: envUrl.replace(/\/+$/, ''), uploadToken: envToken };
    }
    for (const configFile of CLOUD_CONFIG_FILES) {
        try {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
            const url = String(config.url || '').trim().replace(/\/+$/, '');
            const uploadToken = String(config.uploadToken || '').trim();
            if (url && uploadToken) return { url, uploadToken };
        } catch { /* sonraki konumu dene */ }
    }
    return null;
}

function formatReleaseNotes(releaseNotes) {
    const raw = Array.isArray(releaseNotes)
        ? releaseNotes.map(item => item && (item.note || item.notes || item)).filter(Boolean).join('\n')
        : String(releaseNotes || '').trim();
    if (!raw) {
        return 'Bu sürümde performans, güvenilirlik ve kullanım kolaylığı iyileştirmeleri yapıldı.';
    }
    return raw
        .replace(/\r/g, '')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^\s*[-*]\s+/gm, '• ')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
}

function createUpdatePromptWindow(version, notes) {
    const win = new BrowserWindow({
        width: 460, height: 340,
        resizable: false, minimizable: false, maximizable: false,
        frame: false, show: false,
        title: 'Güncelleme',
        icon: path.join(__dirname, 'icon.ico'),
        backgroundColor: '#0f172a',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    const safeVersion = String(version).replace(/[<>&"']/g, '');
    const safeNotes = String(notes).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&#39;','"':'&quot;'}[c]))
        .replace(/•/g, '<span class="bullet">•</span>');
    const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;height:340px;display:flex;flex-direction:column;overflow:hidden;-webkit-app-region:drag}
.header{background:linear-gradient(135deg,#0f766e,#0d9488);padding:20px 24px 18px;flex-shrink:0}
.badge{font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#99f6e4;margin-bottom:6px}
.title{font-size:19px;font-weight:800;color:#fff;line-height:1.2}
.version{font-size:12px;color:#ccfbf1;margin-top:4px;font-weight:500}
.body{flex:1;padding:18px 24px;overflow-y:auto}
.notes-label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px}
.notes{font-size:12.5px;color:#94a3b8;line-height:1.65;white-space:pre-wrap}
.bullet{color:#14b8a6;margin-right:4px}
.footer{padding:14px 24px;display:flex;gap:10px;justify-content:flex-end;background:#0f172a;border-top:1px solid #1e293b;flex-shrink:0;-webkit-app-region:no-drag}
button{border:none;border-radius:8px;font-size:13px;font-weight:700;padding:9px 22px;cursor:pointer;transition:opacity .15s}
.btn-update{background:linear-gradient(135deg,#0f766e,#0d9488);color:#fff}
.btn-update:hover{opacity:.88}
.btn-skip{background:#1e293b;color:#94a3b8}
.btn-skip:hover{background:#273549}
</style></head><body>
<div class="header">
  <div class="badge">Kenan Metal Döküm Planlayıcı</div>
  <div class="title">Yeni sürüm hazır</div>
  <div class="version">v${safeVersion} — mevcut: v${app.getVersion()}</div>
</div>
<div class="body">
  <div class="notes-label">Bu sürümde neler değişti</div>
  <div class="notes">${safeNotes}</div>
</div>
<div class="footer">
  <button class="btn-skip" onclick="location.href='app://update-skip'">Şimdi değil</button>
  <button class="btn-update" onclick="location.href='app://update-accept'">Güncelle ve yeniden başlat</button>
</div></body></html>`;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.once('ready-to-show', () => win.show());
    return win;
}

function createUpdateProgressWindow(version, notes) {
    const win = new BrowserWindow({
        width: 460, height: 340,
        resizable: false, minimizable: false, maximizable: false,
        closable: false, frame: false, show: false,
        title: 'Döküm Planlayıcı Güncelleniyor',
        icon: path.join(__dirname, 'icon.ico'),
        backgroundColor: '#0f172a',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    const safeVersion = String(version).replace(/[<>&"']/g, '');
    const safeNotes = String(notes || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))
        .replace(/•/g, '<span class="bullet">•</span>');
    const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;height:340px;display:flex;flex-direction:column;overflow:hidden;-webkit-app-region:drag}
.header{background:linear-gradient(135deg,#0f766e,#0d9488);padding:20px 24px 18px;flex-shrink:0}
.badge{font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#99f6e4;margin-bottom:6px}
.title{font-size:19px;font-weight:800;color:#fff;line-height:1.2}
.version{font-size:12px;color:#ccfbf1;margin-top:4px;font-weight:500}
.body{flex:1;padding:16px 24px 12px;overflow-y:auto}
.notes-label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px}
.notes{font-size:12.5px;color:#94a3b8;line-height:1.65;white-space:pre-wrap}
.bullet{color:#14b8a6;margin-right:4px}
.footer{padding:14px 24px 16px;background:#0f172a;border-top:1px solid #1e293b;flex-shrink:0}
.status{font-size:12px;color:#64748b;margin-bottom:10px}
.track{height:6px;background:#1e293b;border-radius:99px;overflow:hidden}
.bar{height:100%;width:2%;background:linear-gradient(90deg,#0f766e,#14b8a6);border-radius:99px;transition:width .3s ease}
.foot{display:flex;justify-content:space-between;color:#475569;font-size:11px;margin-top:7px}
</style></head><body>
<div class="header">
  <div class="badge">Kenan Metal Döküm Planlayıcı</div>
  <div class="title">Güncelleme indiriliyor…</div>
  <div class="version">v${safeVersion} yükleniyor — lütfen bekleyin</div>
</div>
<div class="body">
  <div class="notes-label">Bu sürümde neler değişti</div>
  <div class="notes">${safeNotes}</div>
</div>
<div class="footer">
  <div class="status" id="status">İndirme devam ediyor, uygulama birazdan yeniden başlayacak…</div>
  <div class="track"><div class="bar" id="bar"></div></div>
  <div class="foot"><span>Güvenli güncelleme</span><b id="percent">0%</b></div>
</div>
</body></html>`;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.once('ready-to-show', () => win.show());
    return win;
}

async function checkForStartupUpdate() {
    if (!app.isPackaged) return false;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    let progressWindow = null;

    try {
        const checkResult = await Promise.race([
            autoUpdater.checkForUpdates(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('update_check_timeout')), 6000)),
        ]);
        if (!checkResult || !checkResult.isUpdateAvailable) return false;

        const info = checkResult.updateInfo;
        const notes = formatReleaseNotes(info.releaseNotes);

        // Onay yok — direkt progress ekranı aç ve indir
        progressWindow = createUpdateProgressWindow(info.version, notes);
        const onProgress = progress => {
            const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
            if (!progressWindow.isDestroyed()) {
                progressWindow.webContents.executeJavaScript(
                    `document.getElementById("bar").style.width="${percent}%";` +
                    `document.getElementById("percent").textContent="${percent}%";` +
                    `document.getElementById("status").textContent="İndiriliyor… ${percent}%";`
                ).catch(() => {});
            }
        };
        autoUpdater.on('download-progress', onProgress);
        try {
            await autoUpdater.downloadUpdate();
        } finally {
            autoUpdater.removeListener('download-progress', onProgress);
        }
        // Tamamlandı — bar'ı %100'e getir, kısa mesaj göster, hemen kapat ve kur
        if (!progressWindow.isDestroyed()) {
            await progressWindow.webContents.executeJavaScript(
                `document.getElementById("bar").style.width="100%";` +
                `document.getElementById("percent").textContent="100%";` +
                `document.getElementById("status").textContent="Kurulum başlıyor…";`
            ).catch(() => {});
            await new Promise(r => setTimeout(r, 800));
            progressWindow.close();
        }
        autoUpdater.quitAndInstall(true, true);
        return true;
    } catch (error) {
        if (progressWindow && !progressWindow.isDestroyed()) progressWindow.destroy();
        console.warn('Açılış güncelleme kontrolü başarısız:', error && error.message);
        return false;
    }
}

// IPC: load data from network
ipcMain.handle('app-version', () => app.getVersion());

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

// IPC: salt-okunur mobil planı Cloudflare'a gönder
ipcMain.handle('cloud-plan-upload', async (event, plan) => {
    const config = readCloudConfig();
    if (!config) return { ok: false, reason: 'not_configured' };
    try {
        const response = await withTimeout(fetch(`${config.url}/api/upload`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.uploadToken}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify(plan),
        }), CLOUD_TIMEOUT_MS);
        if (!response.ok) {
            return { ok: false, reason: 'http_error', status: response.status };
        }
        return { ok: true, publicUrl: config.url };
    } catch (err) {
        return { ok: false, reason: 'connection_error', message: err.message };
    }
});

// IPC: report penceresini aç (temp dosya üzerinden)
ipcMain.handle('open-report-window', async (event, html) => {
    const tmpPath = path.join(os.tmpdir(), 'casting_plan_report.html');
    const baseHref = 'file:///' + __dirname.replace(/\\/g, '/') + '/';
    html = html.replace('<head>', `<head><base href="${baseHref}">`);
    await fsp.writeFile(tmpPath, html, 'utf8');
    const { screen } = require('electron');
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    const winW = Math.min(820, sw);
    const winH = Math.min(1080, sh);
    const win = new BrowserWindow({
        width: winW,
        height: winH,
        x: Math.max(0, Math.round((sw - winW) / 2)),
        y: Math.max(0, Math.round((sh - winH) / 2)),
        title: 'Üretim Planı',
        icon: path.join(__dirname, 'kenan-metal-logo.png'),
        resizable: true,
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
        show: false,
        icon: path.join(__dirname, 'kenan-metal-logo.png'),
        title: 'Kenan Metal - Döküm Planlayıcı',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
        backgroundColor: '#f0f4f8',
    });

    Menu.setApplicationMenu(null);

    const DESIGN_WIDTH = 2560;
    const DESIGN_HEIGHT = 1350;
    const applyResponsiveZoom = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const display = screen.getDisplayMatching(mainWindow.getBounds());
        const width = mainWindow.getContentBounds().width || display.workAreaSize.width;
        const height = mainWindow.getContentBounds().height || display.workAreaSize.height;
        const factor = Math.max(
            0.30,
            Math.min(1, width / DESIGN_WIDTH, height / DESIGN_HEIGHT)
        );
        mainWindow.webContents.setZoomFactor(factor);
    };
    mainWindow.maximize();
    mainWindow.loadFile('index.html');
    mainWindow.once('ready-to-show', () => {
        applyResponsiveZoom();
        mainWindow.show();
    });
    mainWindow.webContents.on('did-finish-load', applyResponsiveZoom);
    mainWindow.on('resize', applyResponsiveZoom);
    mainWindow.on('move', applyResponsiveZoom);
}

app.whenReady().then(async () => {
    if (!gotSingleInstanceLock) return;
    if (await checkForStartupUpdate()) return;
    if (!await acquireApplicationLock()) {
        app.quit();
        return;
    }
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
});

app.on('before-quit', () => { releaseLockSync(); });
app.on('window-all-closed', () => {
    releaseLockSync();
    if (process.platform !== 'darwin') app.quit();
});
