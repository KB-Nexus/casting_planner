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
    if (url.pathname === "/api/plan" && request.method === "GET") {
      if (!(await hasValidSession(request, env))) return json({ error: "unauthorized" }, 401);
      const record = await env.DB.prepare(
        "SELECT payload, updated_at FROM current_plan WHERE id = 1"
      ).first();
      if (!record) return json({ plan: null });
      return json({ plan: JSON.parse(record.payload), updatedAt: record.updated_at });
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
*{box-sizing:border-box}body{margin:0;background:#edf2f6;color:#17212b;font:14px system-ui,-apple-system,Segoe UI,sans-serif}.top{background:#101820;color:#fff;padding:18px max(16px,calc((100vw - 1400px)/2));display:flex;align-items:center;justify-content:space-between;gap:15px}.brand{color:#8dd3c7;font-size:12px;font-weight:850;letter-spacing:.12em;text-transform:uppercase}.top h1{font-size:22px;margin:3px 0}.meta{color:#b8c4ce;font-size:12px}
button{border:1px solid #ffffff30;border-radius:8px;background:#ffffff12;color:#fff;padding:8px 11px;font-weight:700}.shell{max-width:1400px;margin:18px auto;padding:0 12px}.card{background:#fff;border:1px solid #d9e3e9;border-radius:13px;box-shadow:0 8px 28px #17212b10;overflow:hidden}.scroll{overflow:auto;max-height:calc(100vh - 145px)}
table{width:100%;border-collapse:separate;border-spacing:0;min-width:850px}th{position:sticky;top:0;z-index:2;background:#f7fafc;color:#334155;font-size:11px;letter-spacing:.035em;text-transform:uppercase}th,td{border-right:1px solid #cbd5e1;border-bottom:1px solid #cbd5e1;padding:9px 8px;text-align:center;font-weight:700}th:last-child,td:last-child{border-right:0}td:nth-child(n+7){text-align:left}.empty,.loading{padding:40px;text-align:center;color:#64748b}
@media(max-width:600px){.top{padding:14px}.top h1{font-size:19px}.shell{margin:10px auto;padding:0 7px}.scroll{max-height:calc(100vh - 119px)}th,td{padding:8px 6px;font-size:12px}}
</style></head><body><header class="top"><div><div class="brand">Kenan Metal</div><h1>Üretim Planı</h1><div class="meta" id="updated">Yükleniyor…</div></div><form action="/logout" method="post"><button type="submit">Çıkış</button></form></header>
<main class="shell"><section class="card"><div class="scroll" id="content"><div class="loading">Plan yükleniyor…</div></div></section></main>
<script>
const escapeHtml=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
async function loadPlan(){
  const response=await fetch("/api/plan",{cache:"no-store"});
  if(response.status===401){location.reload();return}
  const data=await response.json(),plan=data.plan,content=document.getElementById("content");
  if(!plan){content.innerHTML='<div class="empty">Henüz bir plan gönderilmedi.</div>';document.getElementById("updated").textContent="Son plan bekleniyor";return}
  document.getElementById("updated").textContent="Son güncelleme: "+(plan.generatedAtText||new Date(data.updatedAt).toLocaleString("tr-TR"));
  const head=plan.headers.map(header=>'<th>'+escapeHtml(header)+'</th>').join("");
  const rows=plan.rows.map(row=>'<tr>'+row.cells.map(cell=>'<td style="background:'+safeColor(row.background,"#fff")+';color:'+safeColor(row.foreground,"#111")+'">'+escapeHtml(cell)+'</td>').join("")+'</tr>').join("");
  content.innerHTML='<table><thead><tr>'+head+'</tr></thead><tbody>'+rows+'</tbody></table>';
}
function safeColor(value,fallback){return /^#[0-9a-f]{3,8}$/i.test(value||"")?value:fallback}
loadPlan().catch(()=>{document.getElementById("content").innerHTML='<div class="empty">Plan yüklenemedi. Sayfayı yenileyin.</div>'});
setInterval(()=>loadPlan().catch(()=>{}),15000);
</script></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}
