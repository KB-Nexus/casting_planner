const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/updates/") && request.method === "GET") {
      return serveUpdate(url, env);
    }
    if (!env.VIEWER_PASSWORD || !env.UPLOAD_TOKEN || !env.SESSION_SECRET) {
      return new Response("Cloud secrets are not configured.", { status: 503 });
    }

    if (url.pathname === "/api/upload" && request.method === "POST") {
      return uploadPlan(request, env);
    }
    if (url.pathname === "/api/history-upload" && request.method === "POST") {
      return uploadHistory(request, env);
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      return getAppState(request, env);
    }
    if (url.pathname === "/api/state" && request.method === "POST") {
      return saveAppState(request, env);
    }
    if (url.pathname === "/api/state/backups" && request.method === "GET") {
      return listAppStateBackups(request, env);
    }
    if (url.pathname.startsWith("/api/state/backups/") && request.method === "GET") {
      return loadAppStateBackup(request, env, url.pathname.slice("/api/state/backups/".length));
    }
    if (url.pathname === "/api/audit" && request.method === "POST") {
      return recordAuditEvent(request, env);
    }
    if (url.pathname === "/api/audit" && request.method === "GET") {
      return listAuditEvents(request, env);
    }
    if (url.pathname === "/api/lock/acquire" && request.method === "POST") {
      return acquireLock(request, env);
    }
    if (url.pathname === "/api/lock/heartbeat" && request.method === "POST") {
      return heartbeatLock(request, env);
    }
    if (url.pathname === "/api/lock/release" && request.method === "POST") {
      return releaseLock(request, env);
    }
    if (url.pathname === "/api/lock/status" && request.method === "GET") {
      return lockStatus(request, env);
    }
    if (url.pathname === "/api/plan" && request.method === "GET") {
      if (!(await hasValidSession(request, env))) return json({ error: "unauthorized" }, 401);
      const record = await env.DB.prepare(
        "SELECT payload, updated_at FROM current_plan WHERE id = 1"
      ).first();
      if (!record) return json({ plan: null });
      return json({ plan: JSON.parse(record.payload), updatedAt: record.updated_at });
    }
    if (url.pathname === "/api/history" && request.method === "GET") {
      if (!(await hasValidSession(request, env))) return json({ error: "unauthorized" }, 401);
      const record = await env.DB.prepare(
        "SELECT payload, updated_at FROM completed_history WHERE id = 1"
      ).first();
      if (!record) return json({ records: [], updatedAt: null });
      return json({ records: JSON.parse(record.payload), updatedAt: record.updated_at });
    }
    if (url.pathname === "/login" && request.method === "POST") {
      return login(request, env);
    }
    if (url.pathname === "/logout" && request.method === "POST") {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": "casting_plan_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        },
      });
    }
    if (url.pathname === "/" && request.method === "GET") {
      const authenticated = await hasValidSession(request, env);
      return html(authenticated ? planPage() : loginPage());
    }
    return new Response("Not found", { status: 404 });
  },
};

async function serveUpdate(url, env) {
  const key = decodeURIComponent(url.pathname.slice("/updates/".length));
  if (!key || key.includes("..") || key.includes("\\") || key.startsWith("/")) {
    return new Response("Not found", { status: 404 });
  }
  const object = await env.UPDATES.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", key === "latest.yml"
    ? "no-cache, no-store, must-revalidate"
    : "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  if (key.endsWith(".yml")) headers.set("Content-Type", "text/yaml; charset=utf-8");
  if (key.endsWith(".exe")) headers.set("Content-Type", "application/vnd.microsoft.portable-executable");
  return new Response(object.body, { headers });
}

async function uploadHistory(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  if (!(await secureEqual(authorization, `Bearer ${env.UPLOAD_TOKEN || ""}`))) {
    return json({ error: "unauthorized" }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!Array.isArray(body.records)) return json({ error: "invalid_payload" }, 400);
  const payload = JSON.stringify(body.records);
  if (payload.length > 2_000_000) return json({ error: "payload_too_large" }, 413);
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO completed_history (id, payload, updated_at)
    VALUES (1, ?1, ?2)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).bind(payload, updatedAt).run();
  return json({ ok: true, updatedAt });
}

async function uploadPlan(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  if (!(await secureEqual(authorization, `Bearer ${env.UPLOAD_TOKEN || ""}`))) {
    return json({ error: "unauthorized" }, 401);
  }
  let plan;
  try {
    plan = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!isValidPlan(plan)) return json({ error: "invalid_plan" }, 400);
  const payload = JSON.stringify(plan);
  if (payload.length > 1_000_000) return json({ error: "plan_too_large" }, 413);
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO current_plan (id, payload, updated_at)
    VALUES (1, ?1, ?2)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).bind(payload, updatedAt).run();
  return json({ ok: true, updatedAt });
}

const MAX_APP_STATE_BYTES = 8_000_000;
const MAX_APP_STATE_BACKUPS = 30;
const APP_STATE_BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

async function requireUploadAuth(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  return secureEqual(authorization, `Bearer ${env.UPLOAD_TOKEN || ""}`);
}

function makeStamp(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

async function getAppState(request, env) {
  if (!(await requireUploadAuth(request, env))) return json({ error: "unauthorized" }, 401);
  const record = await env.DB.prepare(
    "SELECT payload, version, updated_at FROM app_state WHERE id = 1"
  ).first();
  if (!record) return json({ payload: null, version: 0, updatedAt: null });
  return json({ payload: JSON.parse(record.payload), version: record.version, updatedAt: record.updated_at });
}

async function saveAppState(request, env) {
  if (!(await requireUploadAuth(request, env))) return json({ error: "unauthorized" }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const { payload, expectedVersion, username, hostname, token } = body || {};
  if (payload === undefined || typeof expectedVersion !== "number" || !token) {
    return json({ error: "invalid_payload" }, 400);
  }
  const payloadText = JSON.stringify(payload);
  if (payloadText.length > MAX_APP_STATE_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }

  const nowIso = new Date().toISOString();
  const lock = await env.DB.prepare(
    "SELECT token, username, hostname, expires_at FROM app_lock WHERE id = 1"
  ).first();
  const lockHeld = lock && lock.token && lock.expires_at && lock.expires_at >= nowIso;
  if (lockHeld && lock.token !== token) {
    return json({
      error: "locked",
      lock: { username: lock.username, hostname: lock.hostname, expiresAt: lock.expires_at },
    }, 423);
  }

  const current = await env.DB.prepare("SELECT version FROM app_state WHERE id = 1").first();
  const currentVersion = current ? current.version : 0;
  if (currentVersion !== expectedVersion) {
    return json({ error: "version_conflict", currentVersion }, 409);
  }

  const nextVersion = currentVersion + 1;
  const updateResult = await env.DB.prepare(`
    INSERT INTO app_state (id, payload, version, updated_at, updated_by_username, updated_by_hostname)
    VALUES (1, ?1, 1, ?2, ?3, ?4)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      version = ?5,
      updated_at = excluded.updated_at,
      updated_by_username = excluded.updated_by_username,
      updated_by_hostname = excluded.updated_by_hostname
    WHERE app_state.version = ?6
  `).bind(payloadText, nowIso, username || null, hostname || null, nextVersion, currentVersion).run();

  if (!updateResult.meta || updateResult.meta.changes === 0) {
    return json({ error: "version_conflict", currentVersion }, 409);
  }

  await maybeCreateAppStateBackup(env, payloadText, nextVersion, username, hostname, nowIso);

  return json({ version: nextVersion, updatedAt: nowIso });
}

async function maybeCreateAppStateBackup(env, payloadText, version, username, hostname, nowIso) {
  const last = await env.DB.prepare(
    "SELECT created_at FROM app_state_backup ORDER BY id DESC LIMIT 1"
  ).first();
  if (last && last.created_at && (Date.parse(nowIso) - Date.parse(last.created_at)) < APP_STATE_BACKUP_MIN_INTERVAL_MS) {
    return;
  }
  const stamp = makeStamp(new Date(nowIso));
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO app_state_backup (stamp, payload, version, created_at, created_by_username, created_by_hostname)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).bind(stamp, payloadText, version, nowIso, username || null, hostname || null),
    env.DB.prepare(`
      DELETE FROM app_state_backup WHERE id NOT IN (
        SELECT id FROM app_state_backup ORDER BY id DESC LIMIT ?1
      )
    `).bind(MAX_APP_STATE_BACKUPS),
  ]);
}

async function listAppStateBackups(request, env) {
  if (!(await requireUploadAuth(request, env))) return json({ error: "unauthorized" }, 401);
  const { results } = await env.DB.prepare(`
    SELECT stamp, created_at, created_by_username, created_by_hostname, length(payload) as sizeBytes
    FROM app_state_backup ORDER BY id DESC LIMIT ?1
  `).bind(MAX_APP_STATE_BACKUPS).all();
  return json({
    backups: (results || []).map(row => ({
      stamp: row.stamp,
      createdAt: row.created_at,
      username: row.created_by_username,
      hostname: row.created_by_hostname,
      sizeBytes: row.sizeBytes,
    })),
  });
}

async function loadAppStateBackup(request, env, rawStamp) {
  if (!(await requireUploadAuth(request, env))) return json({ error: "unauthorized" }, 401);
  const stamp = decodeURIComponent(rawStamp || "");
  if (!stamp) return json({ error: "not_found" }, 404);
  const record = await env.DB.prepare(
    "SELECT payload, version, created_at, created_by_username, created_by_hostname FROM app_state_backup WHERE stamp = ?1 ORDER BY id DESC LIMIT 1"
  ).bind(stamp).first();
  if (!record) return json({ error: "not_found" }, 404);
  return json({
    payload: JSON.parse(record.payload),
    version: record.version,
    createdAt: record.created_at,
    username: record.created_by_username,
    hostname: record.created_by_hostname,
  });
}

const MAX_AUDIT_LOG_ROWS = 5000;

async function recordAuditEvent(request, env) {
  if (!(await requireUploadAuth(request, env))) return json({ error: "unauthorized" }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const { username, hostname, action, detail } = body || {};
  if (!action || typeof action !== "string" || action.length > 100) {
    return json({ error: "invalid_payload" }, 400);
  }
  const detailText = detail === undefined || detail === null ? null : String(detail).slice(0, 2000);
  const nowIso = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO audit_log (ts, username, hostname, action, detail)
      VALUES (?1, ?2, ?3, ?4, ?5)
    `).bind(nowIso, username || null, hostname || null, action, detailText),
    env.DB.prepare(`
      DELETE FROM audit_log WHERE id NOT IN (
        SELECT id FROM audit_log ORDER BY id DESC LIMIT ?1
      )
    `).bind(MAX_AUDIT_LOG_ROWS),
  ]);
  return json({ ok: true, ts: nowIso });
}

async function listAuditEvents(request, env) {
  if (!(await requireUploadAuth(request, env))) return json({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10) || 200));
  const { results } = await env.DB.prepare(`
    SELECT ts, username, hostname, action, detail FROM audit_log ORDER BY id DESC LIMIT ?1
  `).bind(limit).all();
  return json({
    events: (results || []).map(row => ({
      ts: row.ts,
      username: row.username,
      hostname: row.hostname,
      action: row.action,
      detail: row.detail,
    })),
  });
}

async function acquireLock(request, env) {
  if (!(await requireUploadAuth(request, env))) return json({ error: "unauthorized" }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const { token, username, hostname, leaseMs } = body || {};
  if (!token || !leaseMs) return json({ error: "invalid_payload" }, 400);
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + Number(leaseMs)).toISOString();

  const result = await env.DB.prepare(`
    UPDATE app_lock
    SET token = ?1, username = ?2, hostname = ?3, acquired_at = ?4, renewed_at = ?4, lease_ms = ?5, expires_at = ?6
    WHERE id = 1 AND (token IS NULL OR expires_at IS NULL OR expires_at < ?4 OR token = ?1)
  `).bind(token, username || null, hostname || null, nowIso, Number(leaseMs), expiresAt).run();

  if (!result.meta || result.meta.changes === 0) {
    const lock = await env.DB.prepare(
      "SELECT username, hostname, expires_at FROM app_lock WHERE id = 1"
    ).first();
    return json({
      acquired: false,
      lock: { username: lock && lock.username, hostname: lock && lock.hostname, expiresAt: lock && lock.expires_at },
    }, 409);
  }
  return json({ acquired: true, expiresAt });
}

async function heartbeatLock(request, env) {
  if (!(await requireUploadAuth(request, env))) return json({ error: "unauthorized" }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const { token, leaseMs } = body || {};
  if (!token || !leaseMs) return json({ error: "invalid_payload" }, 400);
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + Number(leaseMs)).toISOString();
  const result = await env.DB.prepare(`
    UPDATE app_lock SET renewed_at = ?1, expires_at = ?2 WHERE id = 1 AND token = ?3
  `).bind(nowIso, expiresAt, token).run();
  if (!result.meta || result.meta.changes === 0) {
    return json({ renewed: false }, 409);
  }
  return json({ renewed: true, expiresAt });
}

async function releaseLock(request, env) {
  if (!(await requireUploadAuth(request, env))) return json({ error: "unauthorized" }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const token = body && body.token;
  if (token) {
    await env.DB.prepare(`
      UPDATE app_lock SET token = NULL, username = NULL, hostname = NULL, acquired_at = NULL, renewed_at = NULL, lease_ms = NULL, expires_at = NULL
      WHERE id = 1 AND token = ?1
    `).bind(token).run();
  }
  return json({ released: true });
}

async function lockStatus(request, env) {
  if (!(await requireUploadAuth(request, env))) return json({ error: "unauthorized" }, 401);
  const lock = await env.DB.prepare(
    "SELECT token, username, hostname, expires_at FROM app_lock WHERE id = 1"
  ).first();
  const nowIso = new Date().toISOString();
  const held = Boolean(lock && lock.token && lock.expires_at && lock.expires_at >= nowIso);
  return json({
    held,
    username: held ? lock.username : null,
    hostname: held ? lock.hostname : null,
    expiresAt: held ? lock.expires_at : null,
  });
}

function isValidPlan(plan) {
  return Boolean(
    plan &&
    typeof plan === "object" &&
    Array.isArray(plan.headers) &&
    plan.headers.length > 0 &&
    plan.headers.length <= 20 &&
    plan.headers.every(value => typeof value === "string" && value.length <= 100) &&
    Array.isArray(plan.rows) &&
    plan.rows.length <= 500 &&
    plan.rows.every(row =>
      row && Array.isArray(row.cells) &&
      row.cells.length === plan.headers.length &&
      row.cells.every(value => typeof value === "string" || typeof value === "number")
    )
  );
}

async function login(request, env) {
  const form = await request.formData();
  const password = String(form.get("password") || "");
  if (!(await secureEqual(password, env.VIEWER_PASSWORD || ""))) {
    return html(loginPage("Şifre hatalı."), 401);
  }
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  const body = `v1.${expires}`;
  const signature = await sign(body, env.SESSION_SECRET);
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `casting_plan_session=${body}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
    },
  });
}

async function hasValidSession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)casting_plan_session=([^;]+)/);
  if (!match) return false;
  const parts = match[1].split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = await sign(`${parts[0]}.${parts[1]}`, env.SESSION_SECRET);
  return secureEqual(parts[2], expected);
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret || ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toBase64Url(new Uint8Array(bytes));
}

async function secureEqual(left, right) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(left))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(right))),
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < aa.length; index++) difference |= aa[index] ^ bb[index];
  return difference === 0;
}

function toBase64Url(bytes) {
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function loginPage(error = "") {
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kenan Metal · Üretim Planı</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef2f6;color:#17212b;font:16px system-ui,-apple-system,Segoe UI,sans-serif;padding:20px}
.card{width:min(100%,390px);background:#fff;border:1px solid #dce4ea;border-radius:18px;box-shadow:0 18px 50px #17212b1c;padding:28px}
.brand{font-size:13px;font-weight:800;letter-spacing:.12em;color:#2f6f65;text-transform:uppercase}h1{font-size:25px;margin:8px 0 6px}.sub{color:#64748b;margin:0 0 22px}
label{display:block;font-size:13px;font-weight:750;margin-bottom:7px}input{width:100%;border:1px solid #bdcbd4;border-radius:10px;font:inherit;padding:12px 13px;outline:none}input:focus{border-color:#2f6f65;box-shadow:0 0 0 3px #2f6f6520}
button{width:100%;border:0;border-radius:10px;background:#2f6f65;color:#fff;font:inherit;font-weight:800;padding:12px;margin-top:14px;cursor:pointer}.error{background:#fff1f2;color:#be123c;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:14px}
</style></head><body><main class="card"><div class="brand">Kenan Metal</div><h1>Üretim Planı</h1><p class="sub">Listeyi görüntülemek için şifrenizi girin.</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<form action="/login" method="post"><label for="password">Görüntüleme şifresi</label><input id="password" name="password" type="password" required autofocus autocomplete="current-password"><button type="submit">Giriş yap</button></form>
</main></body></html>`;
}

function planPage() {
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kenan Metal · Üretim Planı</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#edf2f6;color:#17212b;font:14px system-ui,-apple-system,Segoe UI,sans-serif}
.top{background:#101820;color:#fff;padding:18px max(16px,calc((100vw - 1400px)/2));display:flex;align-items:center;justify-content:space-between;gap:15px;flex-wrap:wrap}
.brand{color:#8dd3c7;font-size:12px;font-weight:850;letter-spacing:.12em;text-transform:uppercase}.top h1{font-size:22px;margin:3px 0}.meta{color:#b8c4ce;font-size:12px}
.top-actions{display:flex;gap:8px;align-items:center}
button{border:1px solid #ffffff30;border-radius:8px;background:#ffffff12;color:#fff;padding:8px 11px;font-weight:700;cursor:pointer;font-size:13px}
button.active{background:#2f6f65;border-color:#2f6f65}
.shell{max-width:1400px;margin:18px auto;padding:0 12px}.card{background:#fff;border:1px solid #d9e3e9;border-radius:13px;box-shadow:0 8px 28px #17212b10;overflow:hidden}.scroll{overflow:auto;max-height:calc(100vh - 145px)}
table{width:100%;border-collapse:separate;border-spacing:0;min-width:850px}th{position:sticky;top:0;z-index:2;background:#f7fafc;color:#334155;font-size:11px;letter-spacing:.035em;text-transform:uppercase}th,td{border-right:1px solid #cbd5e1;border-bottom:1px solid #cbd5e1;padding:9px 8px;text-align:center;font-weight:700}th:last-child,td:last-child{border-right:0}td:nth-child(n+7){text-align:left}.empty,.loading{padding:40px;text-align:center;color:#64748b}
.hist-search{display:flex;gap:8px;padding:12px;border-bottom:1px solid #e2e8f0;background:#f8fafc}
.hist-search input{flex:1;border:1px solid #cbd5e1;border-radius:8px;padding:7px 10px;font:inherit;outline:none;min-width:0}
.hist-search input:focus{border-color:#2f6f65;box-shadow:0 0 0 3px #2f6f6520}
.hist-search select{border:1px solid #cbd5e1;border-radius:8px;padding:7px 10px;font:inherit;outline:none;background:#fff}
@media(max-width:600px){.top{padding:14px}.top h1{font-size:19px}.shell{margin:10px auto;padding:0 7px}.scroll{max-height:calc(100vh - 145px)}th,td{padding:8px 6px;font-size:12px}.hist-search{flex-wrap:wrap}}
</style></head>
<body>
<header class="top">
  <div><div class="brand">Kenan Metal</div><h1 id="page-title">Üretim Planı</h1><div class="meta" id="updated">Yükleniyor…</div></div>
  <div class="top-actions">
    <button id="btn-plan" class="active" onclick="showView('plan')">Üretim Planı</button>
    <button id="btn-history" onclick="showView('history')">Geçmiş Dökümler</button>
    <form action="/logout" method="post" style="margin:0"><button type="submit">Çıkış</button></form>
  </div>
</header>
<main class="shell"><section class="card"><div id="content"><div class="loading">Plan yükleniyor…</div></div></section></main>
<script>
const escapeHtml=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
function safeColor(v,f){return /^#[0-9a-f]{3,8}$/i.test(v||"")?v:f}

let currentView='plan';
let historyRecords=[];
let historyFilter='';
let historyDiameter='';

function showView(view){
  currentView=view;
  document.getElementById('btn-plan').classList.toggle('active',view==='plan');
  document.getElementById('btn-history').classList.toggle('active',view==='history');
  document.getElementById('page-title').textContent=view==='plan'?'Üretim Planı':'Geçmiş Dökümler';
  if(view==='plan'){loadPlan();}else{loadHistory();}
}

async function loadPlan(){
  const content=document.getElementById("content");
  const response=await fetch("/api/plan",{cache:"no-store"});
  if(response.status===401){location.reload();return}
  const data=await response.json(),plan=data.plan;
  if(!plan){content.innerHTML='<div class="empty">Henüz bir plan gönderilmedi.</div>';document.getElementById("updated").textContent="Son plan bekleniyor";return}
  document.getElementById("updated").textContent="Son güncelleme: "+(plan.generatedAtText||new Date(data.updatedAt).toLocaleString("tr-TR"));
  const head=plan.headers.map(h=>'<th>'+escapeHtml(h)+'</th>').join("");
  const rows=plan.rows.map(row=>'<tr>'+row.cells.map(cell=>'<td style="background:'+safeColor(row.background,"#fff")+';color:'+safeColor(row.foreground,"#111")+'">'+escapeHtml(cell)+'</td>').join("")+'</tr>').join("");
  content.innerHTML='<div class="scroll"><table><thead><tr>'+head+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
}

async function loadHistory(){
  const content=document.getElementById("content");
  document.getElementById("updated").textContent="";
  // Arama çubuğu yoksa bir kez oluştur (input yeniden oluşturulursa klavye kapanır)
  if(!document.getElementById("hist-search-bar")){
    content.innerHTML=
      '<div class="hist-search" id="hist-search-bar">'
        +'<input id="hist-q" type="search" placeholder="Müşteri, lot, kalite ara…" />'
        +'<select id="hist-diam"><option value="">Tüm çaplar</option></select>'
      +'</div>'
      +'<div id="hist-results"><div class="loading">Geçmiş yükleniyor…</div></div>';
    document.getElementById("hist-q").addEventListener("input",function(){historyFilter=this.value;renderHistoryResults();});
    document.getElementById("hist-diam").addEventListener("change",function(){historyDiameter=this.value;renderHistoryResults();});
  }else{
    document.getElementById("hist-results").innerHTML='<div class="loading">Geçmiş yükleniyor…</div>';
  }
  try{
    const response=await fetch("/api/history",{cache:"no-store"});
    if(response.status===401){location.reload();return}
    const data=await response.json();
    historyRecords=data.records||[];
    const upd=data.updatedAt?new Date(data.updatedAt).toLocaleString("tr-TR"):"";
    document.getElementById("updated").textContent=upd?"Son güncelleme: "+upd:historyRecords.length+" kayıt";
    // Çap seçeneklerini güncelle (select yeniden oluşturulmaz, değer korunur)
    const diameters=[...new Set(historyRecords.map(r=>String(r.diameter||'')).filter(Boolean))].sort();
    const sel=document.getElementById("hist-diam");
    const curDiam=sel.value;
    sel.innerHTML='<option value="">Tüm çaplar</option>'+diameters.map(d=>'<option value="'+escapeHtml(d)+'"'+(curDiam===d?' selected':'')+'>'+escapeHtml(d)+' mm</option>').join('');
    renderHistoryResults();
  }catch(e){
    document.getElementById("hist-results").innerHTML='<div class="empty">Geçmiş yüklenemedi. Sayfayı yenileyin.</div>';
  }
}

function renderHistoryResults(){
  const q=historyFilter.toLowerCase();
  const diam=historyDiameter;
  let records=historyRecords;
  if(q) records=records.filter(r=>
    String(r.lot||'').includes(q)||
    (r.customer||'').toLowerCase().includes(q)||
    (r.quality||'').toLowerCase().includes(q)||
    (r.note||'').toLowerCase().includes(q)
  );
  if(diam) records=records.filter(r=>String(r.diameter||'')===diam);

  const headers=['Tarih','Çap','Müşteri','Lot','Boy','Kalite','Analiz','Not'];
  const head=headers.map(h=>'<th>'+h+'</th>').join('');
  const rows=records.map(r=>{
    const completedAt=r.completedAt?new Date(r.completedAt).toLocaleString("tr-TR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}):"";
    const isKm=(r.customer||'').toUpperCase()==='KM';
    const bg=isKm?'#e0f2fe':'#fff';
    const fg=isKm?'#0c4a6e':'#17212b';
    return '<tr>'
      +'<td style="background:'+bg+';color:'+fg+'">'+escapeHtml(completedAt)+'</td>'
      +'<td style="background:'+bg+';color:'+fg+'">'+escapeHtml(r.diameter||'')+'</td>'
      +'<td style="background:'+bg+';color:'+fg+'">'+escapeHtml(r.customer||'')+'</td>'
      +'<td style="background:'+bg+';color:'+fg+'">'+escapeHtml(r.lot||'')+'</td>'
      +'<td style="background:'+bg+';color:'+fg+'">'+escapeHtml(r.length||'')+'</td>'
      +'<td style="background:'+bg+';color:'+fg+'">'+escapeHtml(r.quality||'')+'</td>'
      +'<td style="background:'+bg+';color:'+fg+';text-align:left">'+escapeHtml(r.analysis||'')+'</td>'
      +'<td style="background:'+bg+';color:'+fg+';text-align:left">'+escapeHtml(r.note||'')+'</td>'
      +'</tr>';
  }).join('');

  const resultsEl=document.getElementById("hist-results");
  if(records.length===0){
    resultsEl.innerHTML='<div class="empty">'+(historyRecords.length===0?'Henüz tamamlanan döküm kaydı yok.':'Arama kriterlerine uyan kayıt bulunamadı.')+'</div>';
  }else{
    resultsEl.innerHTML='<div class="scroll"><table><thead><tr>'+head+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
  }
}

loadPlan().catch(()=>{document.getElementById("content").innerHTML='<div class="empty">Plan yüklenemedi. Sayfayı yenileyin.</div>'});
setInterval(()=>{if(currentView==='plan')loadPlan().catch(()=>{});},15000);
</script></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}
