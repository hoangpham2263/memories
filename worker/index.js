// Memories API — keeps a long-lived Google Drive connection (refresh token in KV),
// so the site never asks to sign in again. Photos live in a private Drive folder;
// the photo list (metadata) lives in KV and is mirrored to memories.json in Drive.
const ORIGINS = ["https://hoangpham.is-a.dev", "http://localhost:8000", "http://localhost:4334"];
const SCOPE = "openid email https://www.googleapis.com/auth/drive.file";
// Only these Google accounts (mine) may be connected as the photo storage
const OWNER_EMAILS = ["quochoang.idx@gmail.com", "hoangpham2263@gmail.com"];
const FOLDER_NAME = "Hoang's Memories";
const LIST_KEY = "photos";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

function cors(req) {
  const origin = req.headers.get("origin") || "";
  return {
    "access-control-allow-origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-admin-key",
    "vary": "origin",
  };
}

// Constant-time-ish compare so the password is not guessable by timing.
function sameKey(a = "", b = "") {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const isAdmin = (req, env) => !!env.ADMIN_PASSWORD && sameKey(req.headers.get("x-admin-key") || "", env.ADMIN_PASSWORD);

// ---------- Google auth ----------
async function accessToken(env) {
  const cached = await env.MEM.get("access_token", "json");
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const refresh = await env.MEM.get("refresh_token");
  if (!refresh) throw new Error("Chưa kết nối Google Drive.");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const t = await r.json();
  if (!t.access_token) throw new Error("Google từ chối làm mới phiên: " + (t.error || r.status));
  await env.MEM.put("access_token", JSON.stringify({ token: t.access_token, exp: Date.now() + t.expires_in * 1000 }));
  return t.access_token;
}

async function drive(env, path, init = {}) {
  const token = await accessToken(env);
  const r = await fetch(`https://www.googleapis.com${path}`, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } });
  if (!r.ok && r.status !== 204) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

async function folderId(env) {
  const saved = await env.MEM.get("folder_id");
  if (saved) return saved;
  const meta = { name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" };
  const r = await drive(env, "/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(meta),
  });
  const { id } = await r.json();
  await env.MEM.put("folder_id", id);
  return id;
}

// Sub-folder under a parent, created once and remembered in KV ("Hà Nội" → "2026-10")
async function childFolder(env, parentId, name) {
  const key = `folder:${parentId}:${name}`;
  const saved = await env.MEM.get(key);
  if (saved) return saved;
  const r = await drive(env, "/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  const { id } = await r.json();
  await env.MEM.put(key, id);
  return id;
}

// Photos: <root>/<Tỉnh>/<YYYY>/…  Thumbnails: <root>/_thumbs/…
async function photoFolder(env, province, takenAt) {
  const root = await folderId(env);
  const year = /^\d{4}/.test(takenAt || "") ? takenAt.slice(0, 4) : "Other";
  const place = await childFolder(env, root, province || "Other");
  return childFolder(env, place, year);
}
const thumbFolder = async (env) => childFolder(env, await folderId(env), "_thumbs");

async function moveFile(env, fileId, toFolder) {
  const r = await drive(env, `/drive/v3/files/${fileId}?fields=parents`);
  const { parents = [] } = await r.json();
  if (parents.includes(toFolder)) return;
  await drive(env, `/drive/v3/files/${fileId}?addParents=${toFolder}&removeParents=${parents.join(",")}&fields=id`, { method: "PATCH" });
}

// multipart/related upload of one file (+ JSON metadata) into a folder
async function uploadFile(env, name, mime, bytes, parent) {
  parent = parent || (await folderId(env));
  const boundary = "mem" + crypto.randomUUID();
  const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent] })}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`;
  const body = new Blob([head, bytes, `\r\n--${boundary}--`]);
  const r = await drive(env, "/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return (await r.json()).id;
}

// ---------- Photo list ----------
const readList = async (env) => (await env.MEM.get(LIST_KEY, "json")) || [];
async function writeList(env, list, ctx) {
  await env.MEM.put(LIST_KEY, JSON.stringify(list));
  // Mirror to Drive in the background so the metadata survives even without KV; the reply does not wait for it
  ctx.waitUntil(mirrorList(env, list));
}
async function mirrorList(env, list) {
  try {
    const saved = await env.MEM.get("list_file_id");
    const bytes = new TextEncoder().encode(JSON.stringify(list, null, 1));
    if (saved) {
      await drive(env, `/upload/drive/v3/files/${saved}?uploadType=media`, { method: "PATCH", headers: { "content-type": "application/json" }, body: bytes });
    } else {
      await env.MEM.put("list_file_id", await uploadFile(env, "memories.json", "application/json", bytes));
    }
  } catch {}
}

const FIELDS = ["title", "note", "province", "place", "takenAt", "lat", "lng", "private", "hash"];
function cleanMeta(input = {}) {
  const out = {};
  for (const k of FIELDS) if (k in input) out[k] = input[k] === "" ? null : input[k];
  if (out.title) out.title = String(out.title).slice(0, 120);
  if (out.note) out.note = String(out.note).slice(0, 1000);
  if (out.place) out.place = String(out.place).slice(0, 120);
  for (const k of ["lat", "lng"]) if (out[k] != null) out[k] = Number(out[k]);
  if ("private" in out) out.private = !!out.private;
  if (out.hash) out.hash = String(out.hash).slice(0, 64);
  return out;
}

// ---------- Routes ----------
async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname;

  // Wrong password 5 times from one address: locked out for 15 minutes
  const sentKey = req.headers.get("x-admin-key") || (path === "/oauth/start" ? url.searchParams.get("key") : "");
  if (sentKey) {
    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    const fails = Number(await env.MEM.get(`fail:${ip}`)) || 0;
    if (fails >= 5) return json({ error: "Nhập sai quá nhiều lần, thử lại sau 15 phút." }, 429);
    if (!sameKey(sentKey, env.ADMIN_PASSWORD || "")) ctx.waitUntil(env.MEM.put(`fail:${ip}`, String(fails + 1), { expirationTtl: 900 }));
    else if (fails) ctx.waitUntil(env.MEM.delete(`fail:${ip}`));
  }

  // Link preview page for a shared trip (Zalo, Messenger… read these tags), then on to the site
  if (path === "/share" && req.method === "GET") {
    const esc = (v) => String(v || "").slice(0, 200).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const trip = (url.searchParams.get("t") || "").replace(/[^\w-]/g, "");
    const cover = (url.searchParams.get("c") || "").replace(/[^\w-]/g, "");
    const to = `https://hoangpham.is-a.dev/memories/${trip ? `#trip=${trip}` : ""}`;
    const title = esc(url.searchParams.get("n") || "Hoang's Memories");
    const desc = esc(url.searchParams.get("d") || "Bản đồ hành trình");
    return new Response(`<!doctype html><html lang="vi"><head><meta charset="utf-8">
<title>${title}</title>
<meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="${desc}">
${cover ? `<meta property="og:image" content="${url.origin}/api/img/${cover}"><meta name="twitter:card" content="summary_large_image">` : ""}
<meta property="og:url" content="${esc(to)}"><meta http-equiv="refresh" content="0;url=${esc(to)}">
</head><body><script>location.replace(${JSON.stringify(to)})</script><a href="${esc(to)}">${title}</a></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
  }

  if (path === "/oauth/start") {
    if (!sameKey(url.searchParams.get("key") || "", env.ADMIN_PASSWORD || "")) return new Response("Sai mật khẩu.", { status: 401 });
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${url.origin}/oauth/callback`,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      // Always show the account chooser, so Google never silently picks another signed-in account
      prompt: "consent select_account",
    });
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302);
  }

  if (path === "/oauth/callback") {
    const code = url.searchParams.get("code");
    if (!code) return new Response("Thiếu mã xác thực.", { status: 400 });
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/oauth/callback`,
        grant_type: "authorization_code",
      }),
    });
    const t = await r.json();
    const page = (msg, status = 200) => new Response(`<meta charset=utf-8><p style='font:16px system-ui;padding:24px'>${msg}</p>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
    // id_token comes straight from Google's token endpoint over TLS, so its payload can be read directly
    const claims = t.id_token ? JSON.parse(atob(t.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) : {};
    if (!OWNER_EMAILS.includes(claims.email)) return page(`Tài khoản ${claims.email || "này"} không có quyền. Hãy đóng tab, bấm lại ổ khóa và chọn ${OWNER_EMAILS.join(" hoặc ")}.`, 403);
    if (!t.refresh_token) return page("Google không trả quyền truy cập lâu dài, thử lại.", 400);
    await env.MEM.put("refresh_token", t.refresh_token);
    await env.MEM.put("access_token", JSON.stringify({ token: t.access_token, exp: Date.now() + t.expires_in * 1000 }));
    await env.MEM.put("drive_email", claims.email);
    return page(`✓ Đã kết nối Google Drive (${claims.email}). Bạn có thể đóng tab này.`);
  }

  if (path === "/api/photos" && req.method === "GET") {
    const list = await readList(env);
    // Private photos are only listed for the owner
    return json(isAdmin(req, env) ? list : list.filter((p) => !p.private), 200, { "cache-control": "no-store" });
  }

  // Trip names/notes/covers and province covers
  if (path === "/api/meta" && req.method === "GET") {
    return json((await env.MEM.get("meta", "json")) || { trips: {}, covers: {} }, 200, { "cache-control": "no-store" });
  }

  // Places visited without photos (ticked by hand)
  if (path === "/api/visited" && req.method === "GET") {
    return json((await env.MEM.get("visited", "json")) || [], 200, { "cache-control": "no-store" });
  }

  // Specific places visited (Núi Bà Đen, Mũi Né…) and places planned next, pinned on the map
  const spots = path.match(/^\/api\/(places|plans)$/)?.[1];
  if (spots && req.method === "GET") {
    return json((await env.MEM.get(spots, "json")) || [], 200, { "cache-control": "no-store" });
  }

  if (path === "/api/status" && req.method === "GET") {
    const admin = isAdmin(req, env);
    return json({
      admin,
      connected: !!(await env.MEM.get("refresh_token")),
      email: await env.MEM.get("drive_email"),
      // Drive folder link only for the owner
      folder: admin ? await env.MEM.get("folder_id") : null,
    });
  }

  // Image proxy: thumbnails and full-size, cached at the edge
  const img = path.match(/^\/api\/img\/([\w-]+)$/);
  if (img && req.method === "GET") {
    const cache = caches.default;
    const hit = await cache.match(req);
    if (hit) return hit;
    const list = await readList(env);
    const item = list.find((p) => p.id === img[1]);
    if (!item || (item.private && !isAdmin(req, env))) return new Response("Không tìm thấy ảnh.", { status: 404 });
    const size = url.searchParams.get("size") === "thumb" ? item.thumbId || item.fileId : item.fileId;
    const r = await drive(env, `/drive/v3/files/${size}?alt=media`);
    const res = new Response(r.body, {
      headers: { "content-type": r.headers.get("content-type") || "image/jpeg", "cache-control": item.private ? "private, no-store" : "public, max-age=31536000, immutable" },
    });
    if (!item.private) ctx.waitUntil(cache.put(req, res.clone()));
    return res;
  }

  // ----- admin only below -----
  if (!path.startsWith("/api/")) return new Response("Not found", { status: 404 });
  if (!isAdmin(req, env)) return json({ error: "Sai mật khẩu quản lý." }, 401);

  if (path === "/api/visited" && req.method === "PUT") {
    const { provinces = [] } = await req.json();
    const clean = [...new Set(provinces.map((x) => String(x).slice(0, 60)).filter(Boolean))].slice(0, 100);
    await env.MEM.put("visited", JSON.stringify(clean));
    return json(clean);
  }

  if (spots && req.method === "PUT") {
    const { places = [] } = await req.json();
    const num = (v) => (Number.isFinite(+v) && v !== null && v !== "" ? +v : null);
    const clean = places.slice(0, 300).map((x) => ({
      name: String(x.name || "").slice(0, 80),
      province: String(x.province || "").slice(0, 60),
      lat: num(x.lat),
      lng: num(x.lng),
      // Planned date for places to go next (YYYY-MM-DD, older entries YYYY-MM)
      date: /^\d{4}-\d{2}(-\d{2})?$/.test(x.date || "") ? x.date : null,
      // Area inside the province (Vũng Tàu, Long Hải…), kind (eat / stay / see / other), note, Google Maps link
      group: String(x.group || "").slice(0, 60),
      kind: ["eat", "stay", "see", "other"].includes(x.kind) ? x.kind : "",
      note: String(x.note || "").slice(0, 500),
      url: /^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)/.test(x.url || "") ? String(x.url).slice(0, 500) : "",
    })).filter((x) => x.name);
    await env.MEM.put(spots, JSON.stringify(clean));
    return json(clean);
  }

  // Follow a short Google Maps link (maps.app.goo.gl/…) to the full URL, which carries the name and coordinates
  if (path === "/api/resolve" && req.method === "GET") {
    const u = url.searchParams.get("u") || "";
    if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps)/.test(u)) return json({ error: "Không phải link Google Maps." }, 400);
    let to = u;
    for (let i = 0; i < 5; i++) {
      const r = await fetch(to, { redirect: "manual" });
      const next = r.headers.get("location");
      if (!next) break;
      to = new URL(next, to).toString();
    }
    return json({ url: to });
  }

  if (path === "/api/meta" && req.method === "PUT") {
    const body = await req.json();
    const clip = (v, n) => (v == null ? "" : String(v).slice(0, n));
    const trips = {};
    for (const [k, t] of Object.entries(body.trips || {}).slice(0, 500)) {
      trips[clip(k, 80)] = { name: clip(t.name, 80), note: clip(t.note, 1000), cover: clip(t.cover, 20) };
    }
    const covers = {};
    for (const [k, v] of Object.entries(body.covers || {}).slice(0, 100)) covers[clip(k, 60)] = clip(v, 20);
    const meta = { trips, covers };
    await env.MEM.put("meta", JSON.stringify(meta));
    return json(meta);
  }

  // Edit or delete many photos in one request
  if (path === "/api/photos/batch" && req.method === "POST") {
    const { action, ids = [], changes = {} } = await req.json();
    const pick = new Set(ids.map(String));
    let list = await readList(env);
    const items = list.filter((p) => pick.has(p.id));
    if (action === "delete") {
      await Promise.all(items.flatMap((it) => [it.fileId, it.thumbId].filter(Boolean)).map((id) => drive(env, `/drive/v3/files/${id}`, { method: "DELETE" }).catch(() => {})));
      list = list.filter((p) => !pick.has(p.id));
    } else {
      const meta = cleanMeta(changes);
      const moving = [];
      for (const it of items) {
        const before = `${it.province}|${(it.takenAt || "").slice(0, 4)}`;
        Object.assign(it, meta);
        if (`${it.province}|${(it.takenAt || "").slice(0, 4)}` !== before) moving.push(it);
      }
      // Target folders first (one per province/year, created once), then every file moves in parallel
      const folders = new Map();
      for (const it of moving) {
        const key = `${it.province}|${(it.takenAt || "").slice(0, 4)}`;
        if (!folders.has(key)) folders.set(key, await photoFolder(env, it.province, it.takenAt).catch(() => null));
      }
      await Promise.all(moving.map((it) => {
        const folder = folders.get(`${it.province}|${(it.takenAt || "").slice(0, 4)}`);
        return folder ? moveFile(env, it.fileId, folder).catch(() => {}) : null;
      }));
    }
    await writeList(env, list, ctx);
    return json(action === "delete" ? { deleted: items.length } : items);
  }

  // Create the Tỉnh/Tháng folders once before parallel uploads, so they never race to create duplicates
  if (path === "/api/folders" && req.method === "POST") {
    const { groups = [] } = await req.json();
    // Provinces in parallel; months of the same province one by one (they share the parent folder)
    const byProv = new Map();
    for (const g of groups.slice(0, 200)) byProv.set(String(g.province || ""), [...(byProv.get(String(g.province || "")) || []), String(g.takenAt || "")]);
    await Promise.all([
      thumbFolder(env),
      ...[...byProv].map(async ([prov, dates]) => { for (const d of dates) await photoFolder(env, prov, d); }),
    ]);
    return json({ ok: true });
  }

  // Step 1 (parallel-safe): store one file in Drive, return its id. Does not touch the list.
  if (path === "/api/upload" && req.method === "POST") {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "Thiếu file ảnh." }, 400);
    const isThumb = form.get("kind") === "thumb";
    const province = String(form.get("province") || "");
    const takenAt = String(form.get("takenAt") || "");
    const parent = isThumb ? await thumbFolder(env) : await photoFolder(env, province, takenAt);
    // "2026-10-20 · Hội An · IMG_1234.jpg" so the Drive folder reads well on its own
    const place = String(form.get("place") || "").replace(/[\\/:*?"<>|]/g, "").slice(0, 60);
    const name = isThumb ? file.name : [takenAt, place, file.name].filter(Boolean).join(" · ");
    const bytes = await file.arrayBuffer();
    let id;
    try {
      id = await uploadFile(env, name, file.type || "image/jpeg", bytes, parent);
    } catch (e) {
      // The folder was probably deleted in Drive: forget every cached folder and try again
      if (!/Drive 404/.test(e.message)) throw e;
      const keys = await env.MEM.list({ prefix: "folder:" });
      await Promise.all([...keys.keys.map((k) => env.MEM.delete(k.name)), env.MEM.delete("folder_id")]);
      const again = isThumb ? await thumbFolder(env) : await photoFolder(env, province, takenAt);
      id = await uploadFile(env, name, file.type || "image/jpeg", bytes, again);
    }
    return json({ id });
  }

  // Original photo info (shown in the detail view only), short strings only
  function cleanExif(e) {
    if (!e || typeof e !== "object") return null;
    const out = {};
    for (const k of ["time", "lens", "iso", "aperture", "shutter", "focal", "size", "gpsPlace", "gpsProvince", "altitude"]) {
      if (e[k] != null && e[k] !== "") out[k] = String(e[k]).slice(0, 80);
    }
    return Object.keys(out).length ? out : null;
  }

  // Step 2: add every uploaded photo to the list in one write, so parallel uploads never overwrite each other
  if (path === "/api/photos" && req.method === "POST") {
    const { items = [] } = await req.json();
    const now = new Date().toISOString();
    const added = items.filter((x) => x && x.fileId).map((x) => ({
      id: crypto.randomUUID().slice(0, 12),
      fileId: String(x.fileId),
      thumbId: x.thumbId ? String(x.thumbId) : null,
      name: String(x.name || "").slice(0, 200),
      width: Number(x.width) || null,
      height: Number(x.height) || null,
      camera: String(x.camera || "").slice(0, 80) || null,
      exif: cleanExif(x.exif),
      createdAt: now,
      ...cleanMeta(x),
    }));
    const list = await readList(env);
    list.push(...added);
    await writeList(env, list, ctx);
    return json(added);
  }

  const one = path.match(/^\/api\/photos\/([\w-]+)$/);
  if (one && req.method === "PATCH") {
    const list = await readList(env);
    const item = list.find((p) => p.id === one[1]);
    if (!item) return json({ error: "Không tìm thấy ảnh." }, 404);
    const before = `${item.province}|${(item.takenAt || "").slice(0, 4)}`;
    Object.assign(item, cleanMeta(await req.json()));
    if (`${item.province}|${(item.takenAt || "").slice(0, 4)}` !== before) {
      try { await moveFile(env, item.fileId, await photoFolder(env, item.province, item.takenAt)); } catch {}
    }
    await writeList(env, list, ctx);
    return json(item);
  }
  if (one && req.method === "DELETE") {
    const list = await readList(env);
    const item = list.find((p) => p.id === one[1]);
    if (!item) return json({ error: "Không tìm thấy ảnh." }, 404);
    await Promise.all([item.fileId, item.thumbId].filter(Boolean).map((id) => drive(env, `/drive/v3/files/${id}`, { method: "DELETE" }).catch(() => {})));
    await writeList(env, list.filter((p) => p.id !== item.id), ctx);
    return json({ ok: true });
  }

  return json({ error: "Không hỗ trợ." }, 404);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    let res;
    try {
      res = await handle(req, env, ctx);
    } catch (e) {
      res = json({ error: e.message || "Lỗi máy chủ." }, 500);
    }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors(req))) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
};
