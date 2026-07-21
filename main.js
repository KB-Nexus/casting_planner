const { app, BrowserWindow, Menu, ipcMain, shell, dialog, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const crypto = require('crypto');

// Yerel güvenlik ağı: bulut ulaşılamaz olduğunda elle kurtarma için son bilinen
// iyi durumun pasif bir kopyası. Otomatik okunmaz, sadece yazılır.
const LOCAL_BACKUP_DIR = 'C:\\apps\\casting-planner\\planner\\PlanlamaData2\\backups';
const LOCAL_SAFETY_NET_MAX_DAILY_FILES = 7;

const LOCK_LEASE_MS = 90 * 1000;
const LOCK_HEARTBEAT_MS = 20 * 1000;
const CLOUD_TIMEOUT_MS = 10000;
const CLOUD_CONFIG_FILES = [
    path.join(app.getPath('userData'), 'cloud-plan.config.json'),
    path.join(__dirname, 'cloud-plan.config.json'),
];

let mainWindow = null;
let lockAcquired = false;
let lockHeartbeatTimer = null;
let lastKnownStateVersion = 0;
const lockToken = crypto.randomUUID();

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

function getSessionFilePath() { return path.join(app.getPath('userData'), 'user-session.json'); }

function loadStoredSession() {
    try {
        const parsed = JSON.parse(fs.readFileSync(getSessionFilePath(), 'utf8'));
        if (parsed && parsed.token && parsed.expiresAt && new Date(parsed.expiresAt) > new Date()) return parsed;
    } catch { /* oturum dosyası yok veya bozuk */ }
    return null;
}

function saveStoredSession(session) {
    try {
        if (session) fs.writeFileSync(getSessionFilePath(), JSON.stringify(session), 'utf8');
        else if (fs.existsSync(getSessionFilePath())) fs.unlinkSync(getSessionFilePath());
    } catch { /* diske yazılamazsa oturum sadece bellekte kalır */ }
}

let currentSession = loadStoredSession();

function getUsername() { return (currentSession && currentSession.username) || os.userInfo().username || 'bilinmeyen'; }
function getHostname() { return os.hostname() || 'bilinmeyen'; }

// Zaman aşımlı async ağ erişim kontrolü
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
}

// Bulut backend'ine (Cloudflare Worker) kimlik doğrulamalı istek atar.
// Bağlantı hatalarını ve "yapılandırma yok" durumunu ayrı reason'larla döner,
// böylece çağıranlar network_unavailable / not_configured'ı ayırt edebilir.
async function cloudRequest(pathName, { method = 'GET', body } = {}) {
    const config = readCloudConfig();
    if (!config) return { ok: false, reason: 'not_configured' };
    try {
        const response = await withTimeout(fetch(`${config.url}${pathName}`, {
            method,
            headers: {
                'Authorization': `Bearer ${config.uploadToken}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        }), CLOUD_TIMEOUT_MS);
        let data = null;
        try { data = await response.json(); } catch { /* boş gövde olabilir */ }
        return { ok: response.ok, status: response.status, data };
    } catch (err) {
        return { ok: false, reason: 'connection_error', message: err.message };
    }
}

async function acquireRemoteLock() {
    const result = await cloudRequest('/api/lock/acquire', {
        method: 'POST',
        body: { token: lockToken, username: getUsername(), hostname: getHostname(), leaseMs: LOCK_LEASE_MS },
    });
    if (result.reason) return result;
    if (result.ok) {
        lockAcquired = true;
        startLockHeartbeat();
        return { ok: true };
    }
    return { ok: false, reason: 'locked', lock: result.data && result.data.lock };
}

async function checkAndAcquireLock() {
    if (lockAcquired) return { ok: true };
    return acquireRemoteLock();
}

function lockOwnerText(lock) {
    if (!lock || typeof lock !== 'object') return 'Kullanıcı bilgisi okunamadı.';
    const lines = [];
    if (lock.username) lines.push(`Kullanıcı: ${lock.username}`);
    if (lock.hostname) lines.push(`Bilgisayar: ${lock.hostname}`);
    if (lock.expiresAt) lines.push(`Kilit süresi: ${new Date(lock.expiresAt).toLocaleString('tr-TR')}`);
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
        const result = await cloudRequest('/api/lock/heartbeat', {
            method: 'POST',
            body: { token: lockToken, leaseMs: LOCK_LEASE_MS },
        });
        if (result.reason) {
            // Geçici bağlantı sorunu — kilidi koru, bir sonraki denemede tekrar dene.
            return;
        }
        if (!result.ok) {
            // Sunucu kilidi başka birine vermiş veya süresi dolmuş.
            lockAcquired = false;
            stopLockHeartbeat();
        }
    }, LOCK_HEARTBEAT_MS);
}

async function releaseLock() {
    if (!lockAcquired) return;
    stopLockHeartbeat();
    await cloudRequest('/api/lock/release', { method: 'POST', body: { token: lockToken } }).catch(() => {});
    lockAcquired = false;
}

// Kapanışta kilidi bırakmayı dener; en fazla 3sn bekler, sonra kendini iptal
// eder. Senkron HTTP mümkün olmadığı için app.quit() bu tamamlanana (veya
// zaman aşımına) kadar 'before-quit' üzerinden ertelenir — aksi halde process
// istek tamamlanmadan sonlanır ve kilit 90sn kira süresi dolana kadar takılı
// kalır.
async function releaseLockBeforeQuit() {
    if (!lockAcquired) return;
    stopLockHeartbeat();
    lockAcquired = false;
    const config = readCloudConfig();
    if (!config) return;
    try {
        await withTimeout(fetch(`${config.url}/api/lock/release`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.uploadToken}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({ token: lockToken }),
        }), 3000);
    } catch { /* en iyi çaba; kira süresi dolunca kendiliğinden düzelir */ }
}

async function acquireApplicationLock() {
    // Bilgisayar yeni açılmışsa (ağ adaptörü/DNS henüz tam hazır değilse) veya
    // geçici bir bağlantı kesintisi varsa tek denemede "internet yok" deyip
    // uygulamayı kapatmak yerine birkaç kez tekrar dene.
    let result;
    for (let attempt = 0; attempt < 4; attempt++) {
        result = await acquireRemoteLock();
        if (result.reason !== 'connection_error') break;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 3000));
    }
    if (result.reason === 'not_configured') {
        dialog.showErrorBox(
            'Bulut yapılandırması eksik',
            'Döküm Planlayıcı bulut bağlantı ayarları bulunamadığı için açılamıyor.'
        );
        return false;
    }
    if (result.reason === 'connection_error') {
        dialog.showErrorBox(
            'İnternet bağlantısı yok',
            'Döküm Planlayıcı buluta ulaşamadığı için açılamıyor.\n\nİnternet bağlantınızı kontrol edip yeniden deneyin.'
        );
        return false;
    }
    if (!result.ok) {
        dialog.showErrorBox(
            'Döküm Planlayıcı kullanımda',
            `Uygulama şu anda başka bir bilgisayarda açık.\n\n${lockOwnerText(result.lock)}`
        );
        return false;
    }
    return true;
}

// Yerel güvenlik ağı: bulut uzun süre ulaşılamaz olursa elle kurtarma için
// son bilinen iyi durumun pasif bir kopyası. IPC/UI'a açılmaz, hata olursa
// ana akışı asla etkilemez.
function writeLocalSafetyNet(data) {
    try {
        fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });
        const json = JSON.stringify(data, null, 2);
        fs.writeFileSync(path.join(LOCAL_BACKUP_DIR, 'last-known-good.json'), json, 'utf8');
        const dayStamp = new Date().toISOString().slice(0, 10);
        const dailyFile = path.join(LOCAL_BACKUP_DIR, `last-known-good_${dayStamp}.json`);
        if (!fs.existsSync(dailyFile)) {
            fs.writeFileSync(dailyFile, json, 'utf8');
            const dailyFiles = fs.readdirSync(LOCAL_BACKUP_DIR)
                .filter(f => f.startsWith('last-known-good_') && f.endsWith('.json'))
                .sort();
            while (dailyFiles.length > LOCAL_SAFETY_NET_MAX_DAILY_FILES) {
                fs.unlinkSync(path.join(LOCAL_BACKUP_DIR, dailyFiles.shift()));
            }
        }
    } catch { /* pasif güvenlik ağı — ana akışı asla etkilemez */ }
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
        // Tamamlandı — bar'ı %100'e getir, pencereyi açık bırak, hemen kur
        // Pencereyi kapatmıyoruz: quitAndInstall app'i sonlandırınca otomatik kapanır
        if (!progressWindow.isDestroyed()) {
            await progressWindow.webContents.executeJavaScript(
                `document.getElementById("bar").style.width="100%";` +
                `document.getElementById("percent").textContent="100%";` +
                `document.getElementById("status").textContent="Kurulum yapılıyor…";`
            ).catch(() => {});
        }
        autoUpdater.quitAndInstall(true, true);
        return true;
    } catch (error) {
        if (progressWindow && !progressWindow.isDestroyed()) progressWindow.destroy();
        console.warn('Açılış güncelleme kontrolü başarısız:', error && error.message);
        return false;
    }
}

ipcMain.handle('app-version', () => app.getVersion());

// IPC: load data from cloud backend
ipcMain.handle('network-load', async () => {
    let result = await cloudRequest('/api/state', { method: 'GET' });
    if (result.reason === 'connection_error') {
        // Geçici bir bağlantı sorunu olabilir (ör. uyanma sonrası) — bir kez daha dene.
        await new Promise(resolve => setTimeout(resolve, 2000));
        result = await cloudRequest('/api/state', { method: 'GET' });
    }
    if (result.reason === 'not_configured') return { ok: false, reason: 'not_configured' };
    if (result.reason === 'connection_error') return { ok: false, reason: 'network_unavailable' };
    if (!result.ok) return { ok: false, reason: 'read_error', message: result.data && result.data.error };
    lastKnownStateVersion = (result.data && result.data.version) || 0;
    const data = result.data ? result.data.payload : null;
    if (data) writeLocalSafetyNet(data);
    return { ok: true, data };
});

// IPC: save data to cloud backend
ipcMain.handle('network-save', async (event, data) => {
    const lockResult = await checkAndAcquireLock();
    if (!lockResult.ok) return lockResult;
    const result = await cloudRequest('/api/state', {
        method: 'POST',
        body: {
            payload: data,
            expectedVersion: lastKnownStateVersion,
            username: getUsername(),
            hostname: getHostname(),
            token: lockToken,
            sessionToken: currentSession && currentSession.token,
        },
    });
    if (result.reason === 'not_configured') return { ok: false, reason: 'not_configured' };
    if (result.reason === 'connection_error') return { ok: false, reason: 'network_unavailable' };
    if (!result.ok) {
        if (result.status === 403) {
            return { ok: false, reason: 'forbidden_role' };
        }
        if (result.status === 401 && result.data && result.data.error === 'session_expired') {
            currentSession = null;
            saveStoredSession(null);
            return { ok: false, reason: 'session_expired' };
        }
        if (result.status === 423) {
            const lock = result.data && result.data.lock;
            const info = lock ? { username: lock.username, hostname: lock.hostname, time: lock.expiresAt } : null;
            return { ok: false, reason: 'locked', info };
        }
        if (result.status === 409) {
            // Başka bir istemci araya yazmış — güncel sürümü çekip tekrar denemesi
            // için renderer'a bildir (yerel veriyi renderer'ın kendi mantığıyla
            // birleştirmesi/üzerine yazması gerekir).
            lastKnownStateVersion = (result.data && result.data.currentVersion) || lastKnownStateVersion;
            return { ok: false, reason: 'version_conflict', currentVersion: lastKnownStateVersion };
        }
        return { ok: false, reason: 'write_error', message: result.data && result.data.error };
    }
    lastKnownStateVersion = result.data.version;
    writeLocalSafetyNet(data);
    return { ok: true };
});

// IPC: get lock/connection status
ipcMain.handle('network-status', async () => {
    const result = await cloudRequest('/api/lock/status', { method: 'GET' });
    if (result.reason) return { available: false };
    const lock = result.data && result.data.held
        ? { username: result.data.username, hostname: result.data.hostname, time: result.data.expiresAt }
        : null;
    return { available: true, lock, myUsername: getUsername(), myHostname: getHostname() };
});

// IPC: giriş yapan kullanıcının oturumunu döner (varsa)
ipcMain.handle('auth-get-session', () => currentSession);

// IPC: kullanıcı adı/şifre ile buluta giriş yapar, oturumu diske kaydeder
ipcMain.handle('auth-login', async (event, username, password) => {
    const config = readCloudConfig();
    if (!config) return { ok: false, reason: 'not_configured' };
    try {
        const response = await withTimeout(fetch(`${config.url}/api/users/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ username, password }),
        }), CLOUD_TIMEOUT_MS);
        const data = await response.json().catch(() => null);
        if (!response.ok) return { ok: false, reason: (data && data.error) || 'login_failed' };
        currentSession = { token: data.token, username: data.username, role: data.role, expiresAt: data.expiresAt };
        saveStoredSession(currentSession);
        return { ok: true, username: currentSession.username, role: currentSession.role };
    } catch (err) {
        return { ok: false, reason: 'connection_error', message: err.message };
    }
});

ipcMain.handle('auth-logout', async () => {
    const outgoingSession = currentSession;
    // Yerel oturumu hemen temizle; sunucudaki oturum kaydını arka planda,
    // renderer'ı bekletmeden sil (yavaş/ölü ağda çıkış anında olsun).
    currentSession = null;
    saveStoredSession(null);
    const config = readCloudConfig();
    if (config && outgoingSession) {
        fetch(`${config.url}/api/users/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ sessionToken: outgoingSession.token }),
        }).catch(() => { /* en iyi çaba */ });
    }
    return { ok: true };
});

async function authenticatedUsersRequest(pathName, extraBody) {
    const config = readCloudConfig();
    if (!config) return { ok: false, reason: 'not_configured' };
    if (!currentSession) return { ok: false, reason: 'unauthorized' };
    try {
        const response = await withTimeout(fetch(`${config.url}${pathName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ sessionToken: currentSession.token, ...extraBody }),
        }), CLOUD_TIMEOUT_MS);
        const data = await response.json().catch(() => null);
        if (!response.ok) return { ok: false, reason: (data && data.error) || 'error' };
        return { ok: true, data };
    } catch (err) {
        return { ok: false, reason: 'connection_error', message: err.message };
    }
}

ipcMain.handle('auth-list-users', () => authenticatedUsersRequest('/api/users/list'));
ipcMain.handle('auth-create-user', (event, { username, password, role }) =>
    authenticatedUsersRequest('/api/users/create', { username, password, role }));
ipcMain.handle('auth-delete-user', (event, username) =>
    authenticatedUsersRequest('/api/users/delete', { username }));

// IPC: buluttaki denetim (audit) kayıtlarını listeler
ipcMain.handle('cloud-audit-list', async (event, limit) => {
    return cloudRequest(`/api/audit?limit=${encodeURIComponent(limit || 300)}`, { method: 'GET' });
});

// IPC: release lock manually
ipcMain.handle('network-release-lock', async () => {
    await releaseLock();
    return { ok: true };
});

// IPC: list backups
ipcMain.handle('network-list-backups', async () => {
    const result = await cloudRequest('/api/state/backups', { method: 'GET' });
    if (result.reason === 'not_configured') return { ok: false, reason: 'not_configured' };
    if (result.reason === 'connection_error') return { ok: false, reason: 'network_unavailable' };
    if (!result.ok) return { ok: false, reason: 'read_error', message: result.data && result.data.error };
    const backups = (result.data.backups || []).map(b => b.stamp);
    return { ok: true, backups };
});

// IPC: load specific backup
ipcMain.handle('network-load-backup', async (event, filename) => {
    const stamp = path.basename(filename);
    const result = await cloudRequest(`/api/state/backups/${encodeURIComponent(stamp)}`, { method: 'GET' });
    if (result.reason === 'not_configured') return { ok: false, reason: 'not_configured' };
    if (result.reason === 'connection_error') return { ok: false, reason: 'network_unavailable' };
    if (result.status === 404) return { ok: false, reason: 'not_found' };
    if (!result.ok) return { ok: false, reason: 'read_error', message: result.data && result.data.error };
    return { ok: true, data: result.data.payload };
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

// IPC: tamamlanan dökümleri Cloudflare'a gönder
ipcMain.handle('cloud-history-upload', async (event, records) => {
    const config = readCloudConfig();
    if (!config) return { ok: false, reason: 'not_configured' };
    try {
        const response = await withTimeout(fetch(`${config.url}/api/history-upload`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.uploadToken}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({ records }),
        }), CLOUD_TIMEOUT_MS);
        if (!response.ok) {
            return { ok: false, reason: 'http_error', status: response.status };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: 'connection_error', message: err.message };
    }
});

// IPC: kritik işlemleri buluttaki audit_log tablosuna kaydet
ipcMain.handle('cloud-audit-log', async (event, action, detail) => {
    const config = readCloudConfig();
    if (!config) return { ok: false, reason: 'not_configured' };
    try {
        const response = await withTimeout(fetch(`${config.url}/api/audit`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.uploadToken}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({ username: getUsername(), hostname: getHostname(), action, detail }),
        }), CLOUD_TIMEOUT_MS);
        if (!response.ok) {
            return { ok: false, reason: 'http_error', status: response.status };
        }
        return { ok: true };
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

let releasingLockBeforeQuit = false;
app.on('before-quit', (event) => {
    if (releasingLockBeforeQuit || !lockAcquired) return;
    event.preventDefault();
    releasingLockBeforeQuit = true;
    releaseLockBeforeQuit().finally(() => app.quit());
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
