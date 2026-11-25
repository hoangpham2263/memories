// Hoang's Memories — travel map of Vietnam (34 provinces, 2025) with photo milestones.
// Photos and their metadata are served by the Cloudflare Worker in worker/ (Google Drive behind it).
(() => {
  const API = "https://memories-api.hoangpham2263.workers.dev";
  // Trips live in a Google Sheet: one tab = one trip. A trip that has not ended yet shows as "Sắp đi" on the map.
  const PLANS_API = "https://script.google.com/macros/s/AKfycby525e2S8Pe4gU2tNHIh3Ps22yvmvaO6vCnPr__m_xm_40rdfI10hR2YFYM8eZY9t_oxw/exec";
  const loadPlans = async () => {
    const d = await (await fetch(PLANS_API)).json();
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); // Vietnam date
    return (d.trips || [])
      .filter((t) => String(t.ngayVe || t.ngayDi || "9999") >= today)
      .map((t) => ({ name: String(t.ten || "").trim(), province: t.tinh || "", lat: Number(t.lat), lng: Number(t.lng), date: t.ngayDi ? String(t.ngayDi) : null, note: t.ghiChu || "" }))
      .filter((r) => r.name && r.lat && r.lng);
  };
  const SHEET_URL = "https://docs.google.com/spreadsheets/d/11qEAvbnRwZB4Mpv4b_tkw9gagU6Z2N0Nh5gRHKeKNLU/edit"; // the trips sheet (private, owner only)
  const ABROAD = "Nước ngoài";
  const OTHER = "Other";
  const TRIP_GAP_DAYS = 2; // photos in the same province within 2 days belong to one trip
  const PALETTE = ["#60a5fa", "#34d399", "#fbbf24", "#f472b6", "#a78bfa", "#fb923c", "#2dd4bf", "#f87171", "#818cf8", "#a3e635"];
  const ISLANDS = [
    { name: "Quần đảo Hoàng Sa", sub: "(Đà Nẵng)", lat: 16.5, lng: 112.0 },
    { name: "Quần đảo Trường Sa", sub: "(Khánh Hòa)", lat: 9.6, lng: 114.2 },
  ];
  // On phones the islands would shrink the mainland too much, so the default view stops a bit east of the coast
  const VN_BOUNDS = matchMedia("(max-width: 640px)").matches ? [[8.4, 102.1], [23.4, 112.6]] : [[8.2, 102.1], [23.4, 115.5]];

  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  // We put the scroll back ourselves once the data is drawn (the browser would do it too early)
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  // UI state kept between visits (open province, year, pages, map view, scroll) so a reload looks the same
  const ui = (() => { try { return JSON.parse(store.get("mem-ui") || "{}"); } catch { return {}; } })();
  let uiTimer;
  const saveUI = (patch) => {
    Object.assign(ui, patch);
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => store.set("mem-ui", JSON.stringify(ui)), 150);
  };

  let photos = []; // everything except albums
  let main = []; // photos without Live Photo clips: what every view shows
  let kids = []; // album "Em Thóc": kept off the map, shown in its own section
  let liveOf = new Map(); // photo id → its Live Photo clip
  let orphans = []; // Live Photo clips whose photo is gone
  const KIDS = "Em Thóc";
  const stem = (n) => n.replace(/^dev-/, "").replace(/\.\w+$/, "").toUpperCase();
  const seconds = (p) => Number((p.exif?.size || "").match(/ (\d+)s$/)?.[1] ?? 99);
  let raw = []; // the list as last loaded, to notice changes made elsewhere
  const setPhotos = (list) => {
    raw = list;
    kids = list.filter((p) => p.album === KIDS);
    photos = list.filter((p) => !p.album);
    areaCache.clear();
    // iPhone Live Photos came in as a photo plus a 1–3 s clip with the same name and day
    const stills = new Map(photos.filter((p) => !p.video && p.name.startsWith("dev-")).map((p) => [stem(p.name), p]));
    liveOf = new Map();
    orphans = [];
    const hide = new Set();
    for (const p of photos) {
      if (!p.video || !(p.hash || "").startsWith("vid-dev-") || seconds(p) > 3) continue;
      const still = stills.get(stem(p.name));
      hide.add(p.id);
      still && still.takenAt === p.takenAt ? liveOf.set(still.id, p) : orphans.push(p);
    }
    main = photos.filter((p) => !hide.has(p.id));
  };
  // A photo together with its Live clip, for delete / move
  const withClip = (ids) => ids.flatMap((id) => (liveOf.has(id) ? [id, liveOf.get(id).id] : [id]));
  const areaCache = new Map();
  let year = ""; // year filter, "" = all
  // Photos of the chosen year (all when no filter): what the map, trips, stats and timeline show
  const shown = () => (year ? main.filter((p) => (p.takenAt || "").startsWith(year)) : main);
  let manual = []; // provinces ticked as visited without photos
  let places = []; // specific places visited: { name, province, lat, lng }
  let plans = []; // places to go next, same shape
  let meta = { trips: {}, covers: {} }; // trip names/notes/covers, province covers
  let geo = null;
  let provinces = []; // names, sorted
  let selected = null; // province name, list title, or null
  let adminKey = store.get("mem-admin");
  let admin = false;
  let selecting = false;
  const picked = new Set();
  let map, layer, pinLayer, placeLayer;
  const labels = {};

  // ---------- helpers ----------
  let toastTimer;
  function toast(text, ms = 2200) {
    let el = document.querySelector(".toast");
    if (!el) { el = Object.assign(document.createElement("div"), { className: "toast", role: "status" }); document.body.append(el); }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), ms);
  }
  let toastBox;
  function toastAction(text, label, fn) {
    toastBox?.remove();
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label });
    toastBox = Object.assign(document.createElement("div"), { className: "toast act show" });
    toastBox.append(text, b);
    document.body.append(toastBox);
    const box = toastBox;
    b.onclick = () => { box.remove(); fn(); };
    setTimeout(() => box.remove(), 9000);
  }
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c != null));
    return node;
  };
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const photoDate = (p) => p.takenAt || p.createdAt || "";
  const fmtDate = (s) => {
    if (!s) return "";
    const d = new Date(s);
    return isNaN(d) ? "" : d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  };
  const slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const byProvince = () => {
    const m = new Map();
    for (const p of shown()) if (p.province) m.set(p.province, [...(m.get(p.province) || []), p]);
    return m;
  };
  const newestFirst = (list) => [...list].sort((a, b) => photoDate(b).localeCompare(photoDate(a)));
  const download = (blob, name) => {
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (adminKey) headers["x-admin-key"] = adminKey;
    const r = await fetch(API + path, { ...opts, headers });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `Lỗi ${r.status}`), { status: r.status });
    return data;
  }
  const jsonBody = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // Files need the password, so they are fetched as blobs: at most 8 at once, retried when the server is busy
  const blobCache = new Map();
  const queue = [];
  let running = 0;
  function pump() {
    while (running < 8 && queue.length) {
      const job = queue.shift();
      running++;
      job().finally(() => { running--; pump(); });
    }
  }
  function blobUrl(url, first) {
    if (!blobCache.has(url)) {
      blobCache.set(url, new Promise((done) => {
        const job = async () => {
          for (let i = 0; i < 4; i++) {
            try {
              const r = await fetch(url, { headers: { "x-admin-key": adminKey || "" } });
              if (r.ok) return done(URL.createObjectURL(await r.blob()));
              if (r.status === 404 || r.status === 401) break;
            } catch {}
            await new Promise((ok) => setTimeout(ok, 500 * 2 ** i));
          }
          blobCache.delete(url);
          done("");
        };
        first ? queue.unshift(job) : queue.push(job);
        pump();
      }));
    }
    return blobCache.get(url);
  }
  // Thumbnails load only when they come near the screen
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      seen.unobserve(e.target);
      const img = e.target;
      blobUrl(img._url).then((src) => { if (src) img.src = src; });
    }
  }, { rootMargin: "500px 0px" });
  function setImg(img, p, size) {
    const url = `${API}/api/img/${p.id}${size ? `?size=${size}` : ""}`;
    if (size === "thumb" && img.id !== "viewerImg") { img._url = url; return seen.observe(img); }
    blobUrl(url, true).then((src) => { if (src && (img.id !== "viewerImg" || current() === p)) img.src = src; });
  }
  // Videos: the poster is the thumbnail, the file is fetched like a photo (as a blob when private)
  function setVideo(video, p) {
    const url = `${API}/api/img/${p.id}`;
    video.poster = "";
    blobUrl(url, true).then((src) => { if (src && current() === p) video.src = src; });
  }

  // ---------- geometry ----------
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function provinceAt(lat, lng) {
    if (!geo || lat == null || lng == null) return null;
    for (const f of geo.features) {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) {
        if (inRing(lng, lat, poly[0]) && !poly.slice(1).some((hole) => inRing(lng, lat, hole))) return f.properties.name;
      }
    }
    // Coast and islands: the simplified borders miss some points, take the nearest province within ~30 km
    let best = null, bestD = 0.3 ** 2;
    for (const f of geo.features) {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) for (const [x, y] of poly[0]) {
        const d = (x - lng) ** 2 + (y - lat) ** 2;
        if (d < bestD) { bestD = d; best = f.properties.name; }
      }
    }
    return best;
  }
  const labelOf = (name) => geo.features.find((f) => f.properties.name === name)?.properties.label; // [lng, lat]

  // ---------- areas ----------
  // Where inside the province: the pinned place nearby (your own names), else the ward from GPS
  const km = (a, b) => {
    const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
    return Math.hypot(x, y) * 6371;
  };
  const ACCENTS = { "hoa-khanh": "Hòa Khánh", "hoi-an": "Hội An", "hai-chau": "Hải Châu", "hoa-cuong": "Hòa Cường", "thanh-khe": "Thanh Khê", "tay-ho": "Tây Hồ" };
  const cleanArea = (n) => { const t = String(n || "").replace(/,.*$/, "").replace(/\s+-\s+.*$/, "").trim(); return ACCENTS[slug(t)] || t; };
  function areaOf(p) {
    if (areaCache.has(p.id)) return areaCache.get(p.id);
    let name = "";
    if (p.lat != null) {
      let min = Infinity;
      for (const x of places) {
        if (x.lat == null) continue;
        const d = km(p, x), reach = /vườn quốc gia/i.test(x.name) ? 25 : 8;
        if (d <= reach && d < min) { min = d; name = titleCase(x.group || x.name); }
      }
    }
    name ||= cleanArea(p.place) || "Chưa rõ khu vực";
    areaCache.set(p.id, name);
    return name;
  }

  // ---------- trips ----------
  // Home = wherever many different days were spent (≈25 km squares with 8+ days). A trip = days spent 20+ km from every home.
  // Photos without GPS taken on those days belong to the trip too.
  function computeTrips() {
    const gps = main.filter((p) => p.lat != null && p.takenAt);
    const cells = new Map();
    for (const p of gps) {
      const k = `${Math.round(p.lat * 4)},${Math.round(p.lng * 4)}`;
      const c = cells.get(k) || cells.set(k, { days: new Set(), lat: 0, lng: 0, n: 0 }).get(k);
      c.days.add(p.takenAt); c.lat += p.lat; c.lng += p.lng; c.n++;
    }
    const homes = [...cells.values()].filter((c) => c.days.size >= 8).map((c) => ({ lat: c.lat / c.n, lng: c.lng / c.n }));
    const away = (p) => homes.every((h) => km(p, h) > 20);
    const days = [...groupBy(gps, (p) => p.takenAt).entries()].filter(([, l]) => l.filter(away).length * 2 >= l.length).map(([d]) => d).sort();
    const runs = [];
    for (const d of days) {
      const cur = runs.at(-1);
      if (cur && (new Date(d) - new Date(cur.end)) / 86400000 <= TRIP_GAP_DAYS) cur.end = d;
      else runs.push({ start: d, end: d });
    }
    const trips = [];
    for (const t of runs) {
      if (year && !t.start.startsWith(year)) continue;
      t.photos = byDate(main.filter((p) => p.takenAt >= t.start && p.takenAt <= t.end)).reverse();
      const far = t.photos.filter((p) => p.lat != null && away(p));
      if (t.photos.length < 3 || !far.length) continue;
      t.places = [...groupBy(far, areaOf).entries()].sort((x, y) => y[1].length - x[1].length).map(([n]) => n);
      t.province = [...groupBy(far, (p) => p.province || "").entries()].sort((x, y) => y[1].length - x[1].length)[0][0];
      t.key = `${slug(t.province || "chuyen")}-${t.start}`;
      const m = meta.trips[t.key] || {};
      t.name = m.name || t.places.slice(0, 2).join(", ");
      t.note = m.note || "";
      t.cover = t.photos.find((p) => p.id === m.cover) || far.find((p) => !p.video) || far[0];
      trips.push(t);
    }
    return trips.sort((x, y) => y.end.localeCompare(x.end));
  }
  const tripRange = (t) => {
    const a = new Date(t.start), b = new Date(t.end);
    if (t.start === t.end) return fmtDate(t.start);
    if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return `${a.getDate()}–${fmtDate(t.end)}`;
    return `${fmtDate(t.start)} – ${fmtDate(t.end)}`;
  };
  const coverOf = (province) => {
    const list = byProvince().get(province) || [];
    return list.find((p) => p.id === meta.covers[province]) || newestFirst(list).find((p) => !p.video) || list[0];
  };
  const saveMeta = async (next) => {
    meta = await api("/api/meta", jsonBody("PUT", next));
    renderAll();
  };

  // ---------- map ----------
  function colorOf(name) {
    const i = provinces.indexOf(name);
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
  }
  const placesIn = (province) => places.filter((x) => x.province === province);
  // Visited = has photos, a pinned place, or ticked by hand
  // With a year filter, only provinces with photos from that year
  const visitedSet = () => new Set([...byProvince().keys(), ...(year ? [] : [...manual, ...places.map((x) => x.province)])].filter((n) => provinces.includes(n)));

  function styleFor(feature) {
    const hasPhotos = byProvince().has(feature.properties.name);
    const visited = hasPhotos || visitedSet().has(feature.properties.name);
    const active = feature.properties.name === selected;
    return {
      color: active ? cssVar("--primary") : cssVar("--bg"),
      weight: active ? 1.25 : 1,
      fillColor: visited ? colorOf(feature.properties.name) : cssVar("--land"),
      fillOpacity: visited ? (hasPhotos ? 0.85 : 0.5) : 1,
    };
  }

  function initMap() {
    // Zoom only with the buttons: wheel / trackpad / pinch keep scrolling the page; drag to pan (not on touch, so the page still scrolls)
    map = L.map("map", { zoomControl: false, attributionControl: false, zoomSnap: 0.1, zoomDelta: 0.5, minZoom: 4.5, maxZoom: 13, scrollWheelZoom: false, touchZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, dragging: !L.Browser.mobile });
    // Zoom in / out / whole country, styled like the site's buttons
    const Zoom = L.Control.extend({
      options: { position: "topleft" },
      onAdd: () => {
        const box = L.DomUtil.create("div", "map-ctrl");
        const btn = (html, title, fn) => {
          const b = L.DomUtil.create("button", "", box);
          Object.assign(b, { type: "button", innerHTML: html, title });
          b.setAttribute("aria-label", title);
          L.DomEvent.on(b, "click", (e) => { L.DomEvent.stop(e); fn(); });
        };
        btn("+", "Phóng to", () => map.zoomIn());
        btn("−", "Thu nhỏ", () => map.zoomOut());
        btn('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>', "Về toàn cảnh", () => map.flyToBounds(VN_BOUNDS, { padding: [10, 10], duration: 0.6 }));
        L.DomEvent.disableClickPropagation(box);
        return box;
      },
    });
    new Zoom().addTo(map);
    layer = L.geoJSON(geo, {
      style: styleFor,
      onEachFeature: (f, lyr) => {
        lyr.on("click", () => selectProvince(f.properties.name));
        // Hovered province on top so neighbours don't cover half of its border
        lyr.on("mouseover", () => { lyr.setStyle({ weight: 1.25, color: cssVar("--primary") }); lyr.bringToFront(); });
        lyr.on("mouseout", () => { layer.resetStyle(lyr); raiseSelected(); });
      },
    }).addTo(map);

    for (const f of geo.features) {
      const [lng, lat] = f.properties.label;
      labels[f.properties.name] = L.marker([lat, lng], {
        interactive: false,
        icon: L.divIcon({ className: "province-label", html: `<span>${f.properties.name}</span>`, iconSize: [0, 0] }),
      }).addTo(map);
    }
    for (const is of ISLANDS) {
      L.marker([is.lat, is.lng], {
        interactive: false,
        icon: L.divIcon({ className: "island-label", html: `<span><b></b>${is.name}<br>${is.sub}</span>`, iconSize: [0, 0] }),
      }).addTo(map);
    }
    // Own pane above the provinces, so raising a province never hides the dots
    map.createPane("dots").style.zIndex = 450;
    pinLayer = L.layerGroup().addTo(map);
    placeLayer = L.layerGroup().addTo(map);

    map.fitBounds(VN_BOUNDS, { padding: [10, 10] });
    map.setMaxBounds(L.latLngBounds([4, 96], [27, 121]));
    // Same zoom and position as last visit
    if (ui.view) map.setView([ui.view.lat, ui.view.lng], ui.view.z, { animate: false });
    map.on("moveend", () => { const c = map.getCenter(); saveUI({ view: { lat: +c.lat.toFixed(4), lng: +c.lng.toFixed(4), z: map.getZoom() } }); });
    window.addEventListener("resize", () => map.invalidateSize());
  }

  // Small dots that grow a little on hover
  // Dot size: smaller on phones so the map stays readable
  const DOT = matchMedia("(max-width: 640px)").matches ? 1.6 : 2.5;
  const grow = (m) => m.on("mouseover", () => m.setRadius(DOT + 1.5)).on("mouseout", () => m.setRadius(DOT));

  // One small pin per GPS photo
  function drawMarkers() {
    pinLayer.clearLayers();
    const sorted = newestFirst(shown().filter((p) => p.lat != null && p.lng != null));
    for (const p of sorted) {
      const pin = L.circleMarker([p.lat, p.lng], { pane: "dots", radius: DOT, color: "#fff", weight: 1, fillColor: cssVar("--primary"), fillOpacity: 1 });
      pin.bindTooltip([p.place, fmtDate(photoDate(p))].filter(Boolean).join(" · "), { className: "tip", direction: "top" });
      pin.on("click", () => openViewer(sorted, sorted.indexOf(p)));
      grow(pin);
      pinLayer.addLayer(pin);
    }
    // Places visited: small ring, always visible
    placeLayer.clearLayers();
    for (const x of plans) {
      if (x.lat == null || x.lng == null) continue;
      const m = L.circleMarker([x.lat, x.lng], { pane: "dots", radius: DOT, color: "#f59e0b", weight: 1, fillColor: "#fde68a", fillOpacity: 1 });
      m.bindTooltip(`Sắp đi: ${titleCase(x.name)}`, { className: "tip", direction: "top" });
      grow(m);
      placeLayer.addLayer(m);
    }
    for (const x of places) {
      if (x.lat == null || x.lng == null) continue;
      const m = L.circleMarker([x.lat, x.lng], { pane: "dots", radius: DOT, color: cssVar("--muted"), weight: 1, fillColor: cssVar("--bg"), fillOpacity: 1 });
      m.bindTooltip(titleCase(x.name), { className: "tip", direction: "top" });
      if (x.province) m.on("click", () => selectProvince(x.province));
      grow(m);
      placeLayer.addLayer(m);
    }
    updateLayers();
  }

  function updateLayers() {
    const visited = visitedSet();
    for (const [name, m] of Object.entries(labels)) {
      const node = m.getElement();
      if (!node) continue;
      node.classList.toggle("visited", visited.has(name));
      node.style.display = "";
    }
  }

  function refreshMap() {
    if (!layer) return;
    layer.setStyle(styleFor);
    drawMarkers();
  }

  // Selected province on top so its whole border shows
  const raiseSelected = () => layer.eachLayer((l) => l.feature.properties.name === selected && l.bringToFront());

  // ---------- photo tiles ----------
  // Top of the page first: the first images load at once with high priority, the rest lazily as they scroll in.
  // Each image fades in when ready, over a soft placeholder.
  function lazyImg(first, props = {}) {
    const img = el("img", { decoding: "async", loading: first ? "eager" : "lazy", ...props });
    img.fetchPriority = first ? "high" : "low";
    img.addEventListener("load", () => img.classList.add("ready"), { once: true });
    return img;
  }

  function thumbButton(p, list, first = false) {
    const img = el("img", { alt: p.title || "", decoding: "async" });
    img.addEventListener("load", () => img.classList.add("ready"), { once: true });
    setImg(img, p, "thumb");
    const b = el("button", { type: "button", className: "thumb", title: p.title || p.place || p.province || "" }, img,
      p.video ? el("span", { className: "play", textContent: "▶" }) : liveOf.has(p.id) ? el("span", { className: "play", textContent: "LIVE" }) : null);
    b.dataset.id = p.id;
    b.classList.toggle("sel", picked.has(p.id));
    b.onclick = () => {
      if (!selecting) return openViewer(list, list.indexOf(p));
      picked.has(p.id) ? picked.delete(p.id) : picked.add(p.id);
      b.classList.toggle("sel", picked.has(p.id));
      renderSelBar();
    };
    return b;
  }
  const grid = (list) => el("div", { className: "grid" }, ...list.map((p, i) => thumbButton(p, list, i < 9)));

  // ---------- side panel ----------
  // Specific places in one province; the owner adds them here, one province at a time
  async function savePlaces(next, msg) {
    try { places = await api("/api/places", jsonBody("PUT", { places: next })); areaCache.clear(); renderAll(); toast(msg); }
    catch (err) { toast(err.message); }
  }
  // Free OpenStreetMap search (Photon) inside Vietnam, each result with its province
  async function searchSpots(q) {
    try {
      const data = await (await fetch(`https://photon.komoot.io/api/?limit=8&bbox=102,8,110,23.5&q=${encodeURIComponent(q)}`)).json();
      return data.features.map((f) => {
        const [lng, lat] = f.geometry.coordinates;
        return { lat, lng, province: provinceAt(lat, lng) || "", label: [f.properties.name, f.properties.district || f.properties.city].filter(Boolean).join(", ") };
      });
    } catch { return []; }
  }

  // ---------- places to go next (read-only, from the sheet) ----------
  // 2026-12-05 → 05/12/2026 (older entries hold only the month: 2026-12 → 12/2026)
  const monthText = (m) => (!m ? "" : m.length > 7 ? `${m.slice(8)}/${m.slice(5, 7)}/${m.slice(0, 4)}` : `${+m.slice(5)}/${m.slice(0, 4)}`);
  $("sheetBtn").onclick = () => window.open(SHEET_URL, "_blank", "noopener");
  $("settingsBtn").onclick = () => { $("settingsDlg").showModal(); $("settingsBtn").classList.add("open"); };
  // Menu icon turns back from ✕ to ☰ whenever the menu closes
  $("settingsDlg").addEventListener("close", () => $("settingsBtn").classList.remove("open"));
  // Click outside a dialog (on the dark overlay) closes it, except while photos are uploading
  document.querySelectorAll("dialog.dlg").forEach((d) => d.addEventListener("click", (e) => {
    if (e.target === d && !(d.id === "uploadDlg" && $("uploadGo").disabled && !$("upProgress").hidden)) d.close();
  }));
  // Menu shortcuts to the map actions (phones)
  document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => { $("settingsDlg").close(); $(b.dataset.go).click(); }));

  // ---------- places: areas, notes, Google Maps ----------
  // Place names in one style: each all-lowercase word gets a capital (long hải → Long Hải); words already
  // holding capitals (SANGLA, iPhone) stay as typed
  const titleCase = (t) => String(t || "").trim().replace(/\s+/g, " ")
    .replace(/(^|[\s(\-/])(\p{Ll})(\p{Ll}*)(?=$|[\s)\-/,.])/gu, (m, pre, a, rest) => pre + a.toLocaleUpperCase("vi") + rest);
  const KINDS = { see: "📍", eat: "🍜", stay: "🏠", other: "•" };
  const KIND_NAMES = { see: "Tham quan", eat: "Ăn uống", stay: "Chỗ ở", other: "Khác" };
  // Saved link, else a Maps search on the coordinates (or the name)
  const mapsLink = (x) => x.url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(x.lat != null ? `${x.lat},${x.lng}` : `${x.name}, ${x.province}`)}`;
  const isMapsUrl = (q) => /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps|maps\.google\.)/i.test(q);
  // Name and coordinates out of a full Google Maps URL
  function parseMaps(u) {
    const at = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || u.match(/[?&]q(?:uery)?=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
    const nm = u.match(/\/place\/([^/@?]+)/);
    return { lat: at ? +at[1] : null, lng: at ? +at[2] : null, name: nm ? decodeURIComponent(nm[1].replace(/\+/g, " ")) : "" };
  }
  // Places grouped by area: [[area, [places]]], unnamed area last
  function byArea(spots) {
    const m = new Map();
    for (const x of spots) m.set(x.group || "", [...(m.get(x.group || "") || []), x]);
    return [...m].sort((a, b) => (!a[0] ? 1 : !b[0] ? -1 : a[0].localeCompare(b[0], "vi")));
  }
  const ICON_PIN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  const ICON_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  // One place: name + note, then Maps and (owner) edit
  function placeRow(x) {
    const link = el("a", { className: "place-act", href: mapsLink(x), target: "_blank", rel: "noopener", title: "Mở Google Maps", ariaLabel: "Mở Google Maps", innerHTML: ICON_PIN });
    const body = el("span", { className: "place-body" },
      el("span", { className: "place-name", textContent: x.kind ? `${KINDS[x.kind]} ${titleCase(x.name)}` : titleCase(x.name) }),
      x.note ? el("small", { textContent: x.note }) : null);
    const acts = el("span", { className: "place-acts" }, link);
    if (admin) {
      const edit = el("button", { type: "button", className: "place-act", title: "Sửa", ariaLabel: "Sửa", innerHTML: ICON_EDIT });
      edit.onclick = () => editPlace(x);
      acts.append(edit);
    }
    const row = el("div", { className: "place-row" }, body, acts);
    if (admin) {
      // Drag to reorder, or onto another area to move it there
      row.draggable = true;
      row.classList.add("can-drag");
      // Grip handle: the usual six dots that say "drag me"
      row.prepend(el("span", { className: "grip", title: "Kéo để sắp xếp", ariaHidden: "true",
        innerHTML: '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/><circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></svg>' }));
      row.addEventListener("dragstart", (e) => { dragging = x; row.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", x.name); });
      row.addEventListener("dragend", () => { dragging = null; row.classList.remove("dragging"); document.querySelectorAll(".drop-before, .drop-in").forEach((n) => n.classList.remove("drop-before", "drop-in")); });
      row._place = x;
    }
    return row;
  }

  // ---------- drag & drop places between areas ----------
  let dragging = null;
  function dropZone(box, province, area) {
    box.addEventListener("dragover", (e) => {
      if (!dragging) return;
      e.preventDefault();
      document.querySelectorAll(".drop-before, .drop-in").forEach((n) => n.classList.remove("drop-before", "drop-in"));
      const over = e.target.closest(".place-row");
      if (over && over._place !== dragging) over.classList.add("drop-before");
      else box.classList.add("drop-in");
    });
    box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove("drop-in"); });
    box.addEventListener("drop", async (e) => {
      if (!dragging) return;
      e.preventDefault();
      const moved = dragging;
      const before = e.target.closest(".place-row")?._place;
      if (before === moved) return;
      const item = { ...moved, province, group: area };
      const rest = places.filter((y) => y !== moved);
      // Before the row it was dropped on, else after the last place of that area
      let at = before ? rest.indexOf(before) : -1;
      if (at < 0) {
        const last = rest.map((y, i) => (y.province === province && (y.group || "") === area ? i : -1)).filter((i) => i >= 0).pop();
        at = last == null ? rest.length : last + 1;
      }
      rest.splice(at, 0, item);
      await savePlaces(rest, (moved.group || "") === area ? "✓ Đã đổi thứ tự" : `✓ Đã chuyển sang ${titleCase(area) || "Khác"}`);
    });
  }

  // Quick add inside an area: type a name (or paste a Maps link) and Enter; the position is looked up on its own
  async function quickAdd(province, area, text) {
    const q = text.trim();
    if (!q) return;
    let item = { name: "", province, group: area, kind: "", note: "", url: "", lat: null, lng: null };
    try {
      if (isMapsUrl(q)) {
        const pos = await fromMapsLink(q);
        item = { ...item, name: pos.name, lat: pos.lat, lng: pos.lng, url: q };
      } else {
        item.name = q;
        const hit = (await searchSpots(`${q} ${area}`.trim())).find((r) => r.province === province)
          || (await searchSpots(q)).find((r) => r.province === province);
        if (hit) Object.assign(item, { lat: hit.lat, lng: hit.lng });
      }
    } catch (err) { if (!item.name) return toast(err.message); }
    item.name = titleCase(item.name || q);
    item.kind = guessKind(item.name);
    await savePlaces([...places, item], `✓ Đã thêm ${item.name}${item.lat == null ? " (chưa ghim vị trí)" : ""}`);
  }
  function addRow(province, area, placeholder) {
    const input = el("input", { placeholder, autocomplete: "off" });
    const go = el("button", { type: "button", textContent: "Thêm" });
    const run = async () => { go.disabled = true; await quickAdd(province, area, input.value); go.disabled = false; };
    go.onclick = run;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } if (e.key === "Escape") row.replaceWith(open); });
    const row = el("div", { className: "place-add quick-add" }, input, go);
    // Collapsed to a small "+ Thêm" link until needed
    const open = el("button", { type: "button", className: "link quick-open", textContent: "+ Thêm địa điểm" });
    open.onclick = () => { open.replaceWith(row); input.focus(); };
    return open;
  }

  const ICON_TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>';
  // Area heading; the owner can rename it (moves every place in it) or delete it with its places
  function areaHead(province, area, list) {
    const name = el("p", { className: "place-area-name", textContent: titleCase(area) || "Khác" });
    if (!admin || !province || !area) return name;
    const rename = el("button", { type: "button", className: "place-act", title: "Đổi tên khu vực", ariaLabel: "Đổi tên khu vực", innerHTML: ICON_EDIT });
    const del = el("button", { type: "button", className: "place-act", title: "Xóa khu vực", ariaLabel: "Xóa khu vực", innerHTML: ICON_TRASH });
    const head = el("div", { className: "area-head" }, name, el("span", { className: "place-acts" }, rename, del));
    rename.onclick = () => {
      const input = el("input", { value: titleCase(area), autocomplete: "off" });
      const ok = el("button", { type: "button", textContent: "Lưu" });
      const save = async () => {
        const to = titleCase(input.value);
        if (!to || to === titleCase(area)) return renderSide();
        if (newAreas[province]) newAreas[province] = newAreas[province].map((a) => (a === area ? to : a));
        await savePlaces(places.map((x) => (x.province === province && x.group === area ? { ...x, group: to } : x)), `✓ Đã đổi thành ${to}`);
      };
      ok.onclick = save;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } if (e.key === "Escape") renderSide(); });
      head.replaceWith(el("div", { className: "place-add" }, input, ok));
      input.focus();
    };
    del.onclick = async () => {
      if (list.length && !confirm(`Xóa khu vực "${titleCase(area)}" và ${list.length} địa điểm trong đó?`)) return;
      if (newAreas[province]) newAreas[province] = newAreas[province].filter((a) => a !== area);
      if (!list.length) return renderSide();
      await savePlaces(places.filter((x) => !(x.province === province && x.group === area)), `Đã xóa ${titleCase(area)}`);
    };
    return head;
  }

  // New, still empty areas the owner has started in this session (per province)
  const newAreas = {};
  function placeTree(spots, province) {
    const areas = byArea(spots);
    if (admin && province) for (const a of newAreas[province] || []) if (!areas.some(([n]) => n === a)) areas.push([a, []]);
    // Area headings only once some place has an area
    const grouped = areas.some(([n]) => n);
    const tree = el("div", { className: "place-tree" }, ...areas.map(([area, list]) => {
      const box = el("div", { className: "place-area" },
        grouped ? areaHead(province, area, list) : null,
        ...list.map(placeRow),
        admin && province ? addRow(province, area, `Thêm vào ${titleCase(area) || "đây"}: tên hoặc link Maps`) : null);
      if (admin && province) dropZone(box, province, area);
      return box;
    }));
    if (admin && province) {
      // Start a new area: name it, then add places into it
      const input = el("input", { placeholder: "Khu vực mới (vd: Long Hải)", autocomplete: "off" });
      const go = el("button", { type: "button", textContent: "Tạo" });
      const make = () => {
        const n = titleCase(input.value);
        if (!n) return input.focus();
        (newAreas[province] ||= []).push(n);
        renderSide();
      };
      go.onclick = make;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); make(); } });
      tree.append(el("div", { className: "place-add new-area" }, input, go));
    }
    return tree;
  }

  // Add / edit one place in a dialog
  let editing = null; // { place (null = new), draft }
  // One form for a visited place: province, name + position (search or Maps link), kind, date, area, note
  function editPlace(x, draft) {
    editing = { place: x || null, draft: { ...(draft || x) } };
    const d = editing.draft, f = $("placeForm");
    $("placeDlgTitle").textContent = x ? "Sửa địa điểm" : "Thêm địa điểm đã đi";
    if (f.province.options.length < 2) provinceOptions(f.province, "", "Chọn tỉnh");
    f.province.value = d.province || "";
    f.name.value = d.name || "";
    f.group.value = d.group || "";
    f.kind.value = d.kind || "";
    f.note.value = d.note || "";
    f.url.value = d.url || "";
    $("placeFound").replaceChildren();
    showPin();
    fillAreas();
    $("placeDelete").hidden = !x;
    $("placeDlg").showModal();
    if (!x) f.name.focus();
  }
  const showPin = () => { $("placePin").textContent = editing.draft.lat != null ? "📍 Đã ghim vị trí trên bản đồ" : "Chưa có vị trí: bấm \"Tìm vị trí\" hoặc dán link Google Maps"; };
  // Area suggestions from the chosen province
  const fillAreas = () => $("groupList").replaceChildren(...[...new Set(places.filter((y) => y.province === $("placeForm").province.value).map((y) => y.group).filter(Boolean))].map((g) => el("option", { value: g })));
  $("placeForm").province.onchange = fillAreas;
  // Guess the kind from the name (homestay → stay, quán/chợ/cafe → eat…)
  const guessKind = (n) => /homestay|hotel|khách sạn|resort|nhà nghỉ|villa|motel|hostel/i.test(n) ? "stay"
    : /quán|nhà hàng|chợ|cafe|cà phê|coffee|bún|phở|bánh|lẩu|nướng|hải sản|ốc|restaurant|food|ăn/i.test(n) ? "eat" : n ? "see" : "";
  const setPos = ({ lat, lng, province, name, url }, auto = false) => {
    const f = $("placeForm");
    Object.assign(editing.draft, { lat, lng });
    // From a pasted link: take its province; from a search: only fill when empty
    if (province && (auto || !f.province.value)) f.province.value = province;
    if (auto && name && !f.kind.value) f.kind.value = guessKind(name);
    if (name && (!f.name.value || isMapsUrl(f.name.value))) f.name.value = name;
    if (url) f.url.value = url;
    $("placeFound").replaceChildren();
    showPin();
    fillAreas();
    // Area from the position (Phước Hải, Long Hải…) when not set yet
    if (lat != null && !f.group.value) placeName(lat, lng).then((n) => { if (n && !f.group.value) f.group.value = titleCase(n); });
  };
  async function fromMapsLink(u) {
    let full = /goo\.gl/.test(u) ? (await api(`/api/resolve?u=${encodeURIComponent(u)}`)).url : u;
    // Google sometimes stops at a consent page; the real Maps URL is in its "continue" parameter
    const cont = full.match(/[?&]continue=([^&]+)/);
    if (cont) full = decodeURIComponent(cont[1]);
    const pos = parseMaps(full);
    if (pos.lat == null) throw new Error("Link không có vị trí, thử mở link trên máy rồi copy lại.");
    return { ...pos, province: provinceAt(pos.lat, pos.lng) || "", url: u };
  }
  $("placeFind").onclick = async () => {
    const f = $("placeForm"), q = f.name.value.trim(), out = $("placeFound");
    if (!q) return f.name.focus();
    out.replaceChildren(el("p", { className: "muted small", textContent: "Đang tìm…" }));
    try {
      if (isMapsUrl(q)) return setPos(await fromMapsLink(q), true);
      const only = f.province.value;
      const found = (await searchSpots(q)).filter((r) => r.province && (!only || r.province === only)).slice(0, 6);
      out.replaceChildren(...found.map((r) => {
        const b = el("button", { type: "button" }, el("span", { textContent: r.label }), el("small", { textContent: r.province }));
        b.onclick = () => setPos(r);
        return b;
      }), ...(found.length ? [] : [el("p", { className: "muted small", textContent: `Không thấy "${q}"${only ? ` ở ${only}` : ""}. Có thể lưu không ghim vị trí.` })]));
    } catch (err) { out.replaceChildren(el("p", { className: "muted small", textContent: err.message })); }
  };
  $("placeForm").name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("placeFind").click(); } });
  // Paste a Google Maps link: name, position, province, area and kind fill in by themselves
  for (const box of [$("placeForm").name, $("placeForm").url]) {
    box.addEventListener("paste", () => setTimeout(async () => {
      const u = box.value.trim();
      if (!isMapsUrl(u)) return;
      $("placePin").textContent = "Đang đọc link…";
      try { setPos(await fromMapsLink(u), true); toast("✓ Đã lấy thông tin từ link"); }
      catch (err) { showPin(); toast(err.message); }
    }));
  }
  $("placeSave").onclick = async () => {
    const f = $("placeForm");
    // A link pasted as the name or in the link box also gives the position
    for (const u of [f.name.value.trim(), f.url.value.trim()]) {
      if (isMapsUrl(u) && u !== editing.draft.url && editing.draft.lat == null) { try { setPos(await fromMapsLink(u), true); } catch {} }
    }
    const name = titleCase(isMapsUrl(f.name.value) ? "" : f.name.value);
    if (!name) return toast("Nhập tên địa điểm");
    if (!f.province.value) return toast("Chọn tỉnh");
    const url = f.url.value.trim();
    const { lat = null, lng = null } = editing.draft;
    const item = { ...editing.draft, name, province: f.province.value, group: titleCase(f.group.value), kind: f.kind.value,
      note: f.note.value.trim(), url: isMapsUrl(url) ? url : "", lat, lng };
    const next = editing.place ? places.map((y) => (y === editing.place ? item : y)) : [...places, item];
    $("placeDlg").close();
    await savePlaces(next, editing.place ? `✓ Đã lưu ${name}` : `✓ Đã thêm ${name}`);
  };
  $("placeDelete").onclick = async () => {
    const x = editing.place;
    if (!x || !confirm(`Xóa địa điểm "${x.name}"?`)) return;
    $("placeDlg").close();
    await savePlaces(places.filter((y) => y !== x), `Đã xóa ${x.name}`);
  };

  // Side panel of a province: places by area (adding goes through "+ Thêm")
  function placeBox(province, spots) {
    return spots.length || admin ? placeTree(spots, province) : null;
  }


  // ---------- routes ----------
  // #/  ·  #/noi/<tỉnh>[/<khu vực>]  ·  #/thoi-gian  ·  #/album[/<album or trip>]  ·  #/can-xep[/<group>]
  const go = (path) => { location.hash = path; };
  const route = () => {
    const h = decodeURIComponent(location.hash);
    if (h.startsWith("#trip=")) return ["album", h.slice(6)]; // old trip links
    return h.replace(/^#\/?/, "").split("/").filter(Boolean);
  };
  const TABS = [["", "Địa điểm"], ["thoi-gian", "Thời gian"], ["album", "Album"], ["can-xep", "Cần xếp"]];

  // ---------- shared pieces ----------
  const countText = (list) => {
    const v = list.filter((p) => p.video).length, n = list.length - v;
    return [n ? `${n} ảnh` : "", v ? `${v} video` : ""].filter(Boolean).join(" · ") || "0 ảnh";
  };
  const DAYS = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"];
  const dayText = (d) => (d ? `${DAYS[new Date(d).getDay()]}, ${fmtDate(d)}` : "Chưa rõ ngày");
  const monthName = (m) => (m === "?" ? "Chưa rõ ngày" : `Tháng ${+m.slice(5)}, ${m.slice(0, 4)}`);
  const groupBy = (list, key) => {
    const m = new Map();
    for (const p of list) { const k = key(p); m.has(k) ? m.get(k).push(p) : m.set(k, [p]); }
    return m;
  };
  // Newest first; photos with no date last
  const byDate = (list) => [...list].sort((a, b) => (b.takenAt || "").localeCompare(a.takenAt || "") || (a.exif?.time || "~").localeCompare(b.exif?.time || "~") || a.name.localeCompare(b.name));
  const coverImg = (p, className) => {
    const img = el("img", { className, alt: "", decoding: "async" });
    img.addEventListener("load", () => img.classList.add("ready"), { once: true });
    if (p) setImg(img, p, "thumb");
    return img;
  };
  // One day: date, where, photos. `scope` = the list the viewer steps through
  function daySection(day, list, scope, withProvince) {
    // "Cát Lái, Sài Gòn (TP. Hồ Chí Minh)": areas first, the province once
    const where = [...groupBy(list.filter((p) => p.province), (p) => p.province).entries()].map(([name, l]) => {
      const areas = [...groupBy(l, areaOf).keys()].filter((n) => n !== "Chưa rõ khu vực" && n !== name);
      const text = areas.slice(0, 3).join(", ") + (areas.length > 3 ? ` +${areas.length - 3}` : "");
      return withProvince ? (text ? `${text} (${name})` : name) : text;
    }).filter(Boolean);
    return el("section", { className: "day" },
      el("p", { className: "day-head" }, el("strong", { textContent: dayText(day) }),
        el("span", { className: "muted small", textContent: [where.join(" · "), list.length].filter(Boolean).join("  ·  ") })),
      el("div", { className: "grid" }, ...list.map((p) => thumbButton(p, scope))));
  }
  const dayFeed = (list, withProvince) => {
    const scope = byDate(list);
    return [...groupBy(scope, (p) => p.takenAt || "").entries()].map(([d, l]) => daySection(d, l, scope, withProvince));
  };
  const crumbs = (backTo, backText, title, sub, ...right) => el("div", { className: "view-head" },
    Object.assign(el("button", { type: "button", className: "crumb", textContent: `‹ ${backText}` }), { onclick: () => go(backTo) }),
    el("div", { className: "view-title" }, el("div", {}, el("h2", { textContent: title }), el("p", { className: "muted small", textContent: sub })), el("div", { className: "actions" }, ...right.filter(Boolean))));
  const empty = (text) => el("p", { className: "empty", textContent: text });
  // Photos are for the owner only
  function gate() {
    const b = el("button", { type: "button", className: "primary", textContent: "Nhập mật khẩu" });
    b.onclick = () => $("adminBtn").click();
    return el("div", { className: "empty gate" }, el("p", { textContent: "Ảnh chỉ xem được khi có mật khẩu." }), b);
  }
  let scopeList = []; // photos on screen: what "Chọn tất cả" picks
  const albumPhotos = () => scopeList;

  // ---------- Địa điểm ----------
  function selectProvince(name) { go(`/noi/${slug(name)}`); }
  function renderProvinces(box) {
    const groups = byProvince();
    const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    const noPhotos = [...visitedSet()].filter((n) => !groups.has(n));
    const card = ([name, list]) => {
      const areas = groupBy(list, areaOf).size;
      const b = el("button", { type: "button", className: "prov" }, coverImg(coverOf(name), "prov-cover"),
        el("span", { className: "prov-text" }, el("strong", { textContent: name }),
          el("small", { textContent: `${countText(list)} · ${areas} nơi` })),
        el("i", { className: "prov-dot", style: `background:${colorOf(name)}` }));
      b.onclick = () => selectProvince(name);
      return b;
    };
    const rest = noPhotos.map((n) => {
      const b = el("button", { type: "button", className: "tag", textContent: n });
      b.onclick = () => selectProvince(n);
      return b;
    });
    const todo = shown().filter((p) => !p.province).length;
    const more = todo ? el("button", { type: "button", className: "todo-row" }, el("span", { textContent: `${todo} mục chưa có địa điểm` }), el("span", { className: "link-text", textContent: "Xếp ngay ›" })) : null;
    if (more) more.onclick = () => go("/can-xep");
    box.replaceChildren(...[
      rows.length ? el("div", { className: "prov-list" }, ...rows.map(card)) : admin ? empty("Chưa có ảnh nào.") : gate(),
      rest.length ? el("div", { className: "tag-row" }, el("span", { className: "muted small", textContent: "Đã đến, chưa có ảnh" }), ...rest) : null,
      more,
    ].filter(Boolean));
  }
  let pinnedOpen = false;
  function renderProvince(name, areaSlug) {
    const all = byProvince().get(name) || [];
    const areas = [...groupBy(all, areaOf).entries()].sort((a, b) => b[1].length - a[1].length);
    const area = areas.find(([n]) => slug(n) === areaSlug)?.[0];
    const list = area != null ? areas.find(([n]) => n === area)[1] : all;
    scopeList = list;
    const base = `/noi/${slug(name)}`;
    const chip = (text, n, on, path) => {
      const b = el("button", { type: "button", className: `tag${on ? " on" : ""}` }, text, el("small", { textContent: n }));
      b.onclick = () => go(path);
      return b;
    };
    const spots = placesIn(name);
    const pins = spots.length || admin ? el("details", { className: "pins", open: pinnedOpen }, el("summary", { textContent: `Địa điểm đã ghim · ${spots.length}` }), placeBox(name, spots)) : null;
    if (pins) pins.ontoggle = () => (pinnedOpen = pins.open);
    $("view").replaceChildren(...[
      crumbs("/", "Địa điểm", name, [countText(all), `${areas.length} nơi`].join(" · ")),
      areas.length > 1 ? el("div", { className: "tag-row scroll" }, chip("Tất cả", all.length, area == null, base),
        ...areas.map(([n, l]) => chip(n, l.length, n === area, `${base}/${slug(n)}`))) : null,
      pins,
      ...(list.length ? dayFeed(list, false) : [admin ? empty("Chưa có ảnh ở đây.") : gate()]),
    ].filter(Boolean));
  }

  // ---------- Thời gian ----------
  function renderTime() {
    const list = byDate(shown());
    scopeList = list;
    if (!list.length) return $("view").replaceChildren(admin ? empty("Chưa có ảnh nào.") : gate());
    const months = [...groupBy(list, (p) => (p.takenAt || "").slice(0, 7) || "?").entries()];
    const body = el("div", { className: "time-body" }, ...months.map(([m, l]) =>
      el("section", { className: "month", id: `m-${m}` },
        el("h3", {}, monthName(m), el("small", { textContent: countText(l) })),
        ...[...groupBy(l, (p) => p.takenAt || "").entries()].map(([d, x]) => daySection(d, x, list, true)))));
    const jump = (m) => document.getElementById(`m-${m}`)?.scrollIntoView({ block: "start" });
    const rail = el("nav", { className: "time-rail", ariaLabel: "Chọn tháng" }, ...[...groupBy(months, ([m]) => (m === "?" ? "?" : m.slice(0, 4))).entries()].flatMap(([y, ms]) => [
      el("strong", { textContent: y === "?" ? "Khác" : y }),
      ...ms.map(([m, l]) => Object.assign(el("button", { type: "button" }, m === "?" ? "Chưa rõ ngày" : `Tháng ${+m.slice(5)}`, el("small", { textContent: l.length })), { onclick: () => jump(m) })),
    ]));
    const pick = el("select", { className: "time-pick", ariaLabel: "Đến tháng" }, ...months.map(([m, l]) => el("option", { value: m, textContent: `${monthName(m)} · ${l.length}` })));
    pick.onchange = () => jump(pick.value);
    $("view").replaceChildren(pick, el("div", { className: "time" }, body, rail));
  }

  // ---------- Album ----------
  const KIDS_KEY = "em-thoc";
  function albumCard(cover, title, lines, path) {
    const b = el("button", { type: "button", className: "album-card" }, el("span", { className: "album-cover" }, coverImg(cover)),
      el("strong", { textContent: title }), ...lines.filter(Boolean).map((t) => el("small", { textContent: t })));
    b.onclick = () => go(path);
    return b;
  }
  function renderAlbums() {
    if (!admin) return $("view").replaceChildren(gate());
    const trips = computeTrips();
    const dated = byDate(kids).filter((p) => p.takenAt);
    const range = dated.length ? `${monthText(dated.at(-1).takenAt.slice(0, 7))} – ${monthText(dated[0].takenAt.slice(0, 7))}` : "";
    $("view").replaceChildren(...[
      kids.length ? el("section", { className: "block" }, el("h3", { textContent: "Album riêng" }),
        el("div", { className: "album-grid" }, albumCard(kids.find((p) => p.id === meta.trips[KIDS_KEY]?.cover) || byDate(kids).find((p) => !p.video), KIDS, [countText(kids), range], `/album/${KIDS_KEY}`))) : null,
      el("section", { className: "block" }, el("h3", {}, "Chuyến đi", el("small", { textContent: trips.length })),
        trips.length ? el("div", { className: "album-grid" }, ...trips.map((t) => albumCard(t.cover, t.name, [tripRange(t), countText(t.photos)], `/album/${t.key}`))) : empty("Chưa có chuyến đi nào.")),
    ].filter(Boolean));
  }
  function renderAlbum(key) {
    if (!admin) return $("view").replaceChildren(gate());
    if (key === KIDS_KEY) {
      const list = byDate(kids);
      scopeList = list;
      return $("view").replaceChildren(crumbs("/album", "Album", KIDS, countText(list)),
        ...[...groupBy(list, (p) => (p.takenAt || "").slice(0, 7) || "?").entries()].map(([m, l]) =>
          el("section", { className: "month" }, el("h3", {}, monthName(m), el("small", { textContent: countText(l) })), el("div", { className: "grid" }, ...l.map((p) => thumbButton(p, list))))));
    }
    const t = computeTrips().find((x) => x.key === key);
    if (!t) return go("/album");
    scopeList = t.photos;
    const edit = el("button", { type: "button", textContent: "Sửa" });
    edit.onclick = () => editTrip(t);
    $("view").replaceChildren(...[
      crumbs("/album", "Album", t.name, [tripRange(t), t.places.slice(0, 4).join(", "), countText(t.photos)].filter(Boolean).join(" · "), edit),
      t.note ? el("p", { className: "trip-note", textContent: t.note }) : null,
      ...dayFeed(t.photos, true),
    ].filter(Boolean));
  }
  let editingTrip = null;
  function editTrip(t) {
    editingTrip = t;
    const f = $("tripForm");
    f.name.value = meta.trips[t.key]?.name || "";
    f.name.placeholder = t.name;
    f.note.value = t.note;
    $("tripDlg").showModal();
  }
  $("tripSave").onclick = async () => {
    const t = editingTrip, f = $("tripForm");
    try {
      await saveMeta({ ...meta, trips: { ...meta.trips, [t.key]: { ...(meta.trips[t.key] || {}), name: f.name.value.trim(), note: f.note.value.trim() } } });
      $("tripDlg").close();
      toast("✓ Đã lưu chuyến đi");
    } catch (err) { toast(err.message); }
  };

  // ---------- Cần xếp ----------
  // A photo without GPS, taken on a day when every located photo is in one province, most likely belongs there
  function todoGroups() {
    const days = new Map();
    for (const p of main) if (p.province && p.takenAt) {
      const d = days.get(p.takenAt) || days.set(p.takenAt, { provinces: new Set(), areas: new Map() }).get(p.takenAt);
      d.provinces.add(p.province);
      d.areas.set(areaOf(p), (d.areas.get(areaOf(p)) || 0) + 1);
    }
    const out = { hint: [], place: [], date: [], clip: orphans };
    for (const p of main) {
      if (p.province) { if (!p.takenAt) out.date.push(p); continue; }
      if (!p.takenAt) { out.date.push(p); continue; }
      (days.get(p.takenAt)?.provinces.size === 1 ? out.hint : out.place).push(p);
    }
    return { ...out, days };
  }
  // Save many places at once, offer undo, then tidy the files on Drive in the background
  async function assign(items, msg, undoable = true) {
    const before = items.map(({ id }) => { const p = photos.find((x) => x.id === id); return { id, changes: { province: p.province || "", place: p.place || "" } }; });
    const withClips = items.flatMap((x) => [x, ...(liveOf.has(x.id) ? [{ ...x, id: liveOf.get(x.id).id }] : [])]);
    try {
      applyUpdate(await api("/api/photos/assign", jsonBody("POST", { items: withClips })));
      setPhotos([...photos, ...kids]);
      renderAll();
      undoable ? toastAction(msg, "Hoàn tác", () => assign(before, "Đã hoàn tác", false)) : toast(msg);
      const ids = withClips.map((x) => x.id);
      for (let i = 0; i < ids.length; i += 6) await api("/api/consolidate", jsonBody("POST", { ids: ids.slice(i, i + 6) })).catch(() => {});
    } catch (err) { toast(err.message); }
  }
  function renderTodo(tab) {
    if (!admin) return $("view").replaceChildren(gate());
    const g = todoGroups();
    const tabs = [["goi-y", "Có gợi ý", g.hint], ["chua-ro-noi", "Chưa rõ nơi", g.place], ["chua-ro-ngay", "Chưa rõ ngày", g.date], ["clip-le", "Clip Live lẻ", g.clip]].filter(([, , l]) => l.length);
    if (!tabs.length) return $("view").replaceChildren(empty("Mọi ảnh đều đã có nơi và ngày."));
    const [key, , list] = tabs.find(([k]) => k === tab) || tabs[0];
    const scope = byDate(list);
    scopeList = scope;
    const bar = el("div", { className: "tag-row scroll" }, ...tabs.map(([k, label, l]) =>
      Object.assign(el("button", { type: "button", className: `tag${k === key ? " on" : ""}` }, label, el("small", { textContent: l.length })), { onclick: () => go(`/can-xep/${k}`) })));
    const top = (text, btn) => el("div", { className: "todo-top" }, el("p", { className: "muted small", textContent: text }), btn);
    const body = [];
    if (key === "goi-y") {
      const one = (p) => {
        const d = g.days.get(p.takenAt);
        // The area too, when that day was spent in a single one
        return { id: p.id, changes: { province: [...d.provinces][0], place: d.areas.size === 1 ? [...d.areas.keys()][0] : "" } };
      };
      const all = el("button", { type: "button", className: "primary", textContent: `Xếp cả ${list.length} theo gợi ý` });
      all.onclick = () => { if (confirm(`Xếp ${list.length} mục vào nơi được gợi ý?`)) { all.disabled = true; assign(list.map(one), `✓ Đã xếp ${list.length} mục`); } };
      body.push(top("Không có GPS, nhưng ảnh khác cùng ngày đều ở một nơi.", all));
      for (const [day, l] of groupBy(scope, (p) => p.takenAt)) {
        const d = g.days.get(day), name = [...d.provinces][0];
        const area = [...d.areas.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n)[0];
        body.push(todoDay(day, l, scope, `Cùng ngày: ${[area, name].filter((x, i, a) => a.indexOf(x) === i).join(", ")}`, name, () => assign(l.map(one), `✓ Đã xếp ${l.length} mục vào ${name}`)));
      }
    } else if (key === "chua-ro-noi") {
      body.push(top("Không có GPS và không có ảnh nào cùng ngày để gợi ý. Chọn tỉnh cho cả ngày.", null));
      for (const [day, l] of groupBy(scope, (p) => p.takenAt)) body.push(todoDay(day, l, scope, "", "", null));
    } else if (key === "clip-le") {
      const del = el("button", { type: "button", className: "danger", textContent: `Xóa ${list.length} clip` });
      del.onclick = () => { if (confirm(`Xóa ${list.length} clip khỏi Memories và Google Drive?`)) { scope.forEach((p) => picked.add(p.id)); batch("delete"); } };
      body.push(top("Clip 1–3 giây của Live Photo mà ảnh chính không còn. Không hiện ở các mục khác.", del), el("div", { className: "grid" }, ...scope.map((p) => thumbButton(p, scope))));
    } else {
      body.push(top("File không ghi ngày chụp. Mở từng mục để nhập ngày, hoặc dùng Chọn nhiều.", null), el("div", { className: "grid" }, ...scope.map((p) => thumbButton(p, scope))));
    }
    $("view").replaceChildren(bar, ...body);
  }
  // One day to sort: a strip of photos, the suggestion, and a province picker
  function todoDay(day, list, scope, hint, suggested, accept) {
    const pick = el("select", { ariaLabel: "Chọn tỉnh" });
    provinceOptions(pick, "", suggested ? "Nơi khác…" : "Chọn tỉnh…");
    pick.onchange = () => pick.value && assign(list.map((p) => ({ id: p.id, changes: { province: pick.value, place: "" } })), `✓ Đã xếp ${list.length} mục vào ${pick.value}`);
    const yes = accept ? el("button", { type: "button", className: "primary", textContent: `Xếp vào ${suggested}` }) : null;
    if (yes) yes.onclick = () => { yes.disabled = true; accept(); };
    const strip = el("div", { className: "grid strip" });
    const MAX = isPhone() ? 8 : 14;
    const draw = (n) => strip.replaceChildren(...list.slice(0, n).map((p) => thumbButton(p, scope)));
    draw(selecting ? list.length : MAX);
    const more = list.length > MAX && !selecting ? el("button", { type: "button", className: "link", textContent: `Xem cả ${list.length}` }) : null;
    if (more) more.onclick = () => { draw(list.length); more.remove(); };
    return el("section", { className: "todo-day" },
      el("div", { className: "todo-head" }, el("div", {}, el("strong", { textContent: dayText(day) }), el("p", { className: "muted small", textContent: [hint, countText(list)].filter(Boolean).join(" · ") })),
        el("div", { className: "actions" }, yes, pick)),
      strip, more);
  }

  // ---------- frame: tabs, years, current view ----------
  const isPhone = () => matchMedia("(max-width: 640px)").matches;
  function renderFrame([tab = ""]) {
    const todo = admin ? (() => { const g = todoGroups(); return g.hint.length + g.place.length + g.date.length + g.clip.length; })() : 0;
    const cur = tab === "noi" ? "" : tab;
    $("tabs").replaceChildren(...TABS.filter(([k]) => k !== "can-xep" || todo).map(([k, label]) => {
      const b = el("button", { type: "button", className: k === cur ? "on" : "" }, label, k === "can-xep" ? el("small", { textContent: todo }) : null);
      if (k === cur) b.setAttribute("aria-current", "page");
      b.onclick = () => go(`/${k}`);
      return b;
    }));
    const years = [...new Set(main.map((p) => (p.takenAt || "").slice(0, 4)).filter(Boolean))].sort().reverse();
    $("years").hidden = years.length < 2 || cur === "can-xep" || (cur === "album" && route()[1] === KIDS_KEY);
    $("years").replaceChildren(...["", ...years].map((y) => {
      const b = el("button", { type: "button", className: y === year ? "on" : "", textContent: y || "Tất cả" });
      b.onclick = () => { year = y; saveUI({ year }); renderAll(); };
      return b;
    }));
    const visited = visitedSet();
    $("visitedText").textContent = [`${visited.size}/34 tỉnh, thành phố`, main.length ? countText(shown()) : ""].filter(Boolean).join(" · ");
  }
  function renderAll() {
    const r = route();
    selected = r[0] === "noi" ? provinces.find((n) => slug(n) === r[1]) || null : null;
    scopeList = [];
    renderFrame(r);
    const home = !r.length;
    $("home").hidden = !home;
    $("view").hidden = home;
    if (home) {
      scopeList = shown();
      renderProvinces($("sideBody"));
      map.invalidateSize();
    } else if (r[0] === "noi") selected ? renderProvince(selected, r[2]) : go("/");
    else if (r[0] === "thoi-gian") renderTime();
    else if (r[0] === "album") r[1] ? renderAlbum(r[1]) : renderAlbums();
    else if (r[0] === "can-xep") renderTodo(r[1]);
    else go("/");
    refreshMap();
    if (selecting) renderSelBar();
  }
  const renderSide = renderAll; // the pinned-place editor redraws through this
  // Each address keeps its own scroll position, so going back lands where you were
  const scrolls = {};
  let lastHash = location.hash;
  window.addEventListener("scroll", () => { scrolls[location.hash === lastHash ? lastHash : ""] = window.scrollY; }, { passive: true });
  window.addEventListener("hashchange", () => {
    lastHash = location.hash;
    if (!geo) return;
    const y = scrolls[lastHash] || 0;
    renderAll();
    window.scrollTo(0, y);
  });

  // ---------- viewer ----------
  let viewList = [], viewIndex = 0;
  function openViewer(list, index) {
    viewList = list;
    viewIndex = index;
    showViewer();
    $("viewer").showModal();
  }
  const current = () => viewList[viewIndex];
  function showViewer() {
    const p = current();
    if (!p) return;
    // Small thumbnail at once (usually cached), swapped for the full photo when it has loaded
    const img = $("viewerImg"), vid = $("viewerVid"), clip = liveOf.get(p.id);
    const stop = () => { vid.pause(); vid.removeAttribute("src"); vid.load(); vid.hidden = true; img.hidden = false; };
    stop();
    img.removeAttribute("src");
    if (p.video) { vid.hidden = false; img.hidden = true; setVideo(vid, p); }
    else {
      setImg(img, p, "thumb");
      const full = `${API}/api/img/${p.id}`;
      blobUrl(full, true).then((src) => { if (src && current() === p) img.src = src; });
    }
    $("viewerLive").hidden = !clip;
    $("viewerLive").onclick = async () => {
      if (!vid.hidden) return stop();
      const src = await blobUrl(`${API}/api/img/${clip.id}`, true);
      if (!src || current() !== p) return;
      img.hidden = true; vid.hidden = false; vid.src = src; vid.onended = stop; vid.play().catch(() => {});
    };
    vid.onended = null;
    img.alt = p.title || "";
    const where = [p.province ? areaOf(p) : "", p.province].filter((x, i, l) => x && x !== "Chưa rõ khu vực" && l.indexOf(x) === i).join(", ");
    $("viewerCap").replaceChildren(el("strong", { textContent: p.takenAt ? dayText(p.takenAt) : "Chưa rõ ngày" }), el("span", { textContent: where || (p.album ? p.album : "Chưa có địa điểm") }));
    $("viewerCount").textContent = `${viewIndex + 1} / ${viewList.length}`;
    $("viewerText").replaceChildren(...[p.title ? el("p", {}, el("strong", { textContent: p.title })) : null, p.note ? el("p", { textContent: p.note }) : null, photoInfo(p)].filter(Boolean));
    $("setDate").value = p.takenAt || "";
    $("viewerPrev").hidden = viewIndex <= 0;
    $("viewerNext").hidden = viewIndex >= viewList.length - 1;
    $("viewerTools").hidden = !admin;
    if (admin) {
      $("moveProvince").value = p.province || "";
      $("pinPlace").hidden = p.lat == null;
      $("coverProvince").hidden = !p.province;
      $("coverTrip").hidden = !p.album && !computeTrips().some((t) => t.photos.includes(p));
      $("coverTrip").textContent = p.album ? "Làm ảnh bìa album" : "Làm ảnh bìa chuyến";
    }
  }
  // Original info read from the file at upload time
  function photoInfo(p) {
    const e = p.exif || {};
    const rows = [
      ["Chụp lúc", e.time],
      ["Máy ảnh", p.camera],
      ["Ống kính", e.lens],
      ["Thông số", [e.focal, e.aperture, e.shutter, e.iso ? `ISO ${e.iso}` : ""].filter(Boolean).join(" · ")],
      ["Nơi chụp (GPS)", [e.gpsPlace, e.gpsProvince].filter(Boolean).join(", ")],
      ["Độ cao", e.altitude],
      ["Kích thước", e.size || (p.width ? `${p.width}×${p.height}` : "")],
      ["Tên file", p.name.replace(/^dev-/, "")],
    ].filter(([, v]) => v);
    if (p.lat != null) rows.push(["Tọa độ", el("a", { href: `https://www.google.com/maps?q=${p.lat},${p.lng}`, target: "_blank", rel: "noopener", textContent: `${(+p.lat).toFixed(5)}, ${(+p.lng).toFixed(5)}` })]);
    if (!rows.length) return null;
    return el("div", { className: "photo-info" },
      el("dl", {}, ...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", {}, v)])));
  }
  const step = (d) => { if (viewList[viewIndex + d]) { viewIndex += d; showViewer(); } };
  $("viewerPrev").onclick = () => step(-1);
  $("viewerNext").onclick = () => step(1);
  $("viewerClose").onclick = () => $("viewer").close();
  $("viewer").addEventListener("close", () => { $("viewerVid").pause(); });
  $("viewerInfo").onclick = () => $("viewer").classList.toggle("info");
  // Swipe left / right on phones
  let touchX = null;
  $("viewer").addEventListener("touchstart", (e) => { touchX = e.touches.length === 1 && !e.target.closest(".viewer-info, video") ? e.touches[0].clientX : null; }, { passive: true });
  $("viewer").addEventListener("touchend", (e) => { if (touchX == null) return; const d = e.changedTouches[0].clientX - touchX; if (Math.abs(d) > 50) step(d < 0 ? 1 : -1); }, { passive: true });
  $("setDate").onchange = async (e) => {
    const p = current();
    try {
      applyUpdate(await api("/api/photos/assign", jsonBody("POST", { items: withClip([p.id]).map((id) => ({ id, changes: { takenAt: e.target.value } })) })));
      setPhotos([...photos, ...kids]);
      renderAll(); showViewer(); toast("✓ Đã lưu ngày");
    } catch (err) { toast(err.message); }
  };
  $("viewer").addEventListener("click", (e) => { if (e.target.classList.contains("viewer-stage")) $("viewer").close(); });
  document.addEventListener("keydown", (e) => {
    if (!$("viewer").open || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });

  const applyUpdate = (updated) => {
    for (const u of [].concat(updated)) {
      const p = photos.find((x) => x.id === u.id) || kids.find((x) => x.id === u.id);
      if (p) Object.assign(p, u);
    }
  };

  // Change place: pick a province, saved at once (the file moves to that folder on Drive)
  $("moveProvince").onchange = async (e) => {
    try {
      applyUpdate(await api(`/api/photos/${current().id}`, jsonBody("PATCH", { province: e.target.value, ...(e.target.value === current().province ? {} : { place: "" }) })));
      setPhotos([...photos, ...kids]);
      renderAll();
      showViewer();
      toast(`✓ Đã chuyển sang ${e.target.value || OTHER}`);
    } catch (err) { toast(err.message); }
  };
  // Save where this photo was taken (its GPS) as a visited place
  $("pinPlace").onclick = async () => {
    const p = current();
    if (p.lat == null) return;
    const name = p.exif?.gpsPlace || (await placeName(p.lat, p.lng)) || p.place;
    if (!name) return toast("Không đọc được tên nơi chụp");
    const province = provinceAt(p.lat, p.lng) || p.province || "";
    if (places.some((x) => x.name === name && x.province === province)) return toast(`${name} đã có trong địa điểm`);
    await savePlaces([...places, { name, province, lat: p.lat, lng: p.lng }], `✓ Đã ghim ${name}`);
  };
  $("deleteBtn").onclick = async () => {
    const p = current();
    if (!confirm("Xóa ảnh này khỏi bản đồ và Google Drive?")) return;
    try {
      const ids = withClip([p.id]);
      await api("/api/photos/batch", jsonBody("POST", { action: "delete", ids }));
      setPhotos([...photos, ...kids].filter((x) => !ids.includes(x.id)));
      $("viewer").close();
      renderAll();
      toast("✓ Đã xóa");
    } catch (err) { toast(err.message); }
  };
  $("coverProvince").onclick = async () => {
    const p = current();
    try { await saveMeta({ ...meta, covers: { ...meta.covers, [p.province]: p.id } }); toast(`✓ Đã đặt ảnh bìa cho ${p.province}`); }
    catch (err) { toast(err.message); }
  };
  $("coverTrip").onclick = async () => {
    const p = current();
    const t = p.album ? { key: KIDS_KEY } : computeTrips().find((x) => x.photos.includes(p));
    if (!t) return;
    try { await saveMeta({ ...meta, trips: { ...meta.trips, [t.key]: { ...(meta.trips[t.key] || {}), cover: p.id } } }); toast("✓ Đã đặt ảnh bìa"); }
    catch (err) { toast(err.message); }
  };

  // ---------- multi-select ----------
  function renderSelBar() {
    $("selBar").hidden = !selecting;
    $("selCount").textContent = `Đã chọn ${picked.size} ảnh`;
    for (const id of ["selMove", "selDate", "selDownload", "selDelete"]) $(id).disabled = !picked.size;
    $("selDownload").textContent = picked.size > 1 ? `Tải ${picked.size} ảnh` : "Tải về";
    const scope = albumPhotos();
    const all = scope.length && scope.every((p) => picked.has(p.id));
    $("selAll").textContent = all ? "Bỏ chọn" : `Chọn cả ${scope.length}`;
  }
  function setSelecting(on) {
    selecting = on;
    picked.clear();
    document.body.classList.toggle("selecting", on);
    $("selectBtn").classList.toggle("on", on);
    renderSelBar();
    renderAll();
  }
  async function batch(action, changes) {
    const ids = withClip([...picked]);
    try {
      const res = await api("/api/photos/batch", jsonBody("POST", { action, ids, changes }));
      if (action === "delete") setPhotos([...photos, ...kids].filter((p) => !ids.includes(p.id)));
      else { applyUpdate(res); setPhotos([...photos, ...kids]); }
      picked.clear();
      renderSelBar();
      renderAll();
      toast(action === "delete" ? `✓ Đã xóa ${ids.length} ảnh` : `✓ Đã cập nhật ${ids.length} ảnh`);
    } catch (err) { toast(err.message); }
  }
  $("selectBtn").onclick = () => setSelecting(!selecting);
  $("selDone").onclick = () => setSelecting(false);
  $("selAll").onclick = () => {
    const scope = albumPhotos();
    if (scope.every((p) => picked.has(p.id))) scope.forEach((p) => picked.delete(p.id));
    else scope.forEach((p) => picked.add(p.id));
    document.querySelectorAll(".thumb").forEach((b) => b.classList.toggle("sel", picked.has(b.dataset.id)));
    renderSelBar();
  };
  $("selMove").onclick = () => {
    const province = $("selProvince").value;
    if (!province && !confirm("Chưa chọn tỉnh: các ảnh sẽ thành “chưa rõ nơi”. Tiếp tục?")) return;
    picked.size && assign([...picked].map((id) => ({ id, changes: { province, place: "" } })), `✓ Đã chuyển ${picked.size} mục`).then(() => { picked.clear(); renderSelBar(); renderAll(); });
  };
  $("selDate").onchange = async (e) => {
    if (!picked.size || !e.target.value) return;
    const ids = withClip([...picked]);
    try {
      applyUpdate(await api("/api/photos/assign", jsonBody("POST", { items: ids.map((id) => ({ id, changes: { takenAt: e.target.value } })) })));
      setPhotos([...photos, ...kids]);
      toast(`✓ Đã đặt ngày cho ${picked.size} mục`);
      picked.clear(); e.target.value = ""; renderSelBar(); renderAll();
    } catch (err) { toast(err.message); }
  };
  $("selDelete").onclick = () => confirm(`Xóa ${picked.size} ảnh khỏi bản đồ và Google Drive?`) && batch("delete");

  // ---------- admin ----------
  function provinceOptions(select, value, empty = "— Chọn tỉnh —") {
    select.replaceChildren(el("option", { value: "", textContent: empty }),
      ...[...provinces, ABROAD].map((n) => el("option", { value: n, textContent: n })));
    select.value = value || "";
  }

  const connectDrive = () => {
    toast("Chọn tài khoản Google để lưu ảnh");
    window.open(`${API}/oauth/start?key=${encodeURIComponent(adminKey)}`, "_blank");
  };

  // Signed out: lock button only. Signed in: bar with Drive account, + Thêm ảnh, edit tools.
  function renderAdmin(status) {
    admin = !!(adminKey && status?.admin);
    $("adminBtn").hidden = admin;
    $("adminActions").hidden = !(admin && status.connected);
    $("settingsBtn").hidden = !admin;
    if (!admin && selecting) setSelecting(false);
    if (admin) {
      $("settingsBtn").classList.toggle("warn", !status.connected);
      $("settingsDlg").classList.toggle("warn", !status.connected);
      $("adminText").textContent = status.connected
        ? "Đã kết nối"
        : "Chưa kết nối";
      $("connectBtn").textContent = status.connected ? "Đổi tài khoản Drive" : "Kết nối Drive";
      $("driveLink").hidden = !status.folder;
      if (status.folder) $("driveLink").href = `https://drive.google.com/drive/folders/${status.folder}`;
    }
  }

  // reload: fetch the list again to include private photos (not needed at start, the first load already sent the key)
  async function checkAdmin(reload = true) {
    if (!adminKey) return renderAdmin(null);
    let s;
    try { s = await api("/api/status"); }
    catch (err) {
      // Locked out after too many wrong passwords
      if (err.status === 429) {
        adminKey = null;
        store.set("mem-admin", null);
        renderAdmin(null);
        return toast(err.message, 4000);
      }
      // Network hiccup (sleep, wifi, Worker redeploy): stay signed in, try again on next focus
      return admin ? { admin: true } : undefined;
    }
    // Only a wrong password signs out
    if (!s.admin) {
      adminKey = null;
      store.set("mem-admin", null);
      renderAdmin(null);
      toast("Sai mật khẩu quản lý.");
      return;
    }
    const wasAdmin = admin;
    renderAdmin(s);
    // Owner also sees private photos
    if (!wasAdmin && reload) { try { setPhotos(await api("/api/photos")); renderAll(); } catch {} }
    return s;
  }

  $("adminBtn").onclick = async () => {
    const key = prompt("Mật khẩu quản lý:");
    if (!key) return;
    adminKey = key.trim();
    store.set("mem-admin", adminKey);
    const s = await checkAdmin();
    if (!s) return;
    toast("✓ Đã vào chế độ quản lý");
    if (!s.connected) connectDrive();
  };
  $("logoutBtn").onclick = async () => {
    $("settingsDlg").close();
    adminKey = null;
    store.set("mem-admin", null);
    renderAdmin(null);
    setPhotos([]);
    renderAll();
    toast("Đã thoát chế độ quản lý");
  };
  $("connectBtn").onclick = connectDrive;
  // Coming back from the Google tab: refresh the Drive status
  // Back to the tab: pick up changes made in another tab or device (at most every 20 s)
  let lastSync = Date.now();
  async function syncData() {
    if (Date.now() - lastSync < 20000 || !geo) return;
    lastSync = Date.now();
    try {
      const next = await Promise.all([api("/api/photos"), api("/api/visited"), api("/api/meta"), api("/api/places"), loadPlans()]);
      if (JSON.stringify(next) === JSON.stringify([raw, manual, meta, places, plans])) return;
      [, manual, meta, places, plans] = next;
      setPhotos(next[0]);
      renderAll();
    } catch {}
  }
  window.addEventListener("focus", () => { if (adminKey) checkAdmin(); syncData(); });

  // ---------- backup ----------
  // ---------- download ----------
  const fileName = (p) => [p.takenAt, (p.name || `${p.id}.jpg`).replace(/^dev-/, "")].filter(Boolean).join(" ");
  async function fetchPhoto(p) {
    const r = await fetch(`${API}/api/img/${p.id}`, { headers: adminKey ? { "x-admin-key": adminKey } : {} });
    if (!r.ok) throw new Error(`Lỗi ${r.status}`);
    return r.blob();
  }
  // One photo: the file itself. Several: one ZIP, folders by place / year, several downloads at once
  let downloading = false;
  async function downloadPhotos(list, zipName, extra) {
    if (!list.length || downloading) return;
    downloading = true;
    try {
      if (list.length === 1 && !extra) {
        toast("Đang tải ảnh…", 60000);
        download(await fetchPhoto(list[0]), fileName(list[0]));
        return toast("✓ Đã tải ảnh");
      }
      if (!window.JSZip) return toast("Đang chuẩn bị, thử lại sau vài giây");
      // Big albums are split into ~500 MB parts, so the browser never holds GBs in memory
      const PART = 500 * 1048576;
      let zip = new JSZip(), bytes = 0, part = 0, done = 0, failed = 0;
      if (extra) zip.file("memories.json", extra);
      const flush = async (last) => {
        if (!bytes && !extra) return;
        part++;
        toast("Đang nén…", 60000);
        const name = last && part === 1 ? zipName : zipName.replace(/\.zip$/, `-phan-${part}.zip`);
        download(await zip.generateAsync({ type: "blob" }), name);
        zip = new JSZip(); bytes = 0; extra = null;
      };
      toast(`Đang tải ${list.length} ảnh…`, 60000);
      for (let i = 0; i < list.length; i += 12) {
        await pool(list.slice(i, i + 12), 6, async (p) => {
          try {
            const blob = await fetchPhoto(p);
            bytes += blob.size;
            zip.file(`${p.province || OTHER}/${(p.takenAt || "").slice(0, 4) || OTHER}/${fileName(p)}`, blob);
          } catch { failed++; }
          toast(`Đang tải ${++done}/${list.length} ảnh…`, 60000);
        });
        if (bytes >= PART && i + 12 < list.length) await flush(false);
      }
      await flush(true);
      toast(failed ? `Đã tải ${list.length - failed}/${list.length} ảnh, ${failed} ảnh lỗi` : `✓ Đã tải ${list.length} ảnh${part > 1 ? ` (${part} file ZIP)` : ""}`);
    } catch (err) { toast(err.message); }
    finally { downloading = false; }
  }
  const today = () => new Date().toISOString().slice(0, 10);
  $("viewerDownload").onclick = () => downloadPhotos([current()]);
  $("selDownload").onclick = () => downloadPhotos([...photos, ...kids].filter((p) => picked.has(p.id)), `memories-${picked.size}-anh-${today()}.zip`);
  $("backupZip").onclick = () => downloadPhotos([...photos, ...kids], `memories-album-${today()}.zip`, JSON.stringify({ photos, visited: manual, places, plans, meta }, null, 2));

  // ---------- places visited without photos ----------
  async function saveManual(list) {
    try {
      manual = await api("/api/visited", jsonBody("PUT", { provinces: list }));
      renderAll();
      toast("✓ Đã lưu nơi đã đến");
    } catch (err) { toast(err.message); }
  }
  function openVisited() {
    const withPhotos = byProvince();
    $("visitedList").replaceChildren(...provinces.map((n) => {
      const has = withPhotos.has(n);
      const box = el("input", { type: "checkbox", value: n, checked: has || manual.includes(n), disabled: has });
      return el("label", { className: "vis-item", title: has ? "Đã có ảnh" : "" }, box, el("span", { textContent: n }));
    }));
    $("visitedDlg").showModal();
  }
  $("visitedSave").onclick = async () => {
    await saveManual([...$("visitedList").querySelectorAll("input:checked:not(:disabled)")].map((x) => x.value));
    $("visitedDlg").close();
  };

  // ---------- upload ----------
  let pending = [];

  // Run tasks with at most `limit` in flight
  async function pool(items, limit, task) {
    const out = new Array(items.length);
    let next = 0;
    const run = async () => { while (next < items.length) { const i = next++; out[i] = await task(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return out;
  }

  async function resize(bitmap, max, type, quality) {
    const s = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * s), h = Math.round(bitmap.height * s);
    const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
    c.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, type, quality));
    return { blob, width: w, height: h };
  }

  const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // GPS → "Hội An" style place name (free client-side geocoder, no key)
  const geoCache = new Map();
  async function placeName(lat, lng) {
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (!geoCache.has(key)) {
      geoCache.set(key, fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=vi`)
        .then((r) => r.json())
        // "Phường Hội An" / "Phuong Hoi An" → "Hội An"
        .then((d) => (d.locality || d.city || "").replace(/^(phường|phuong|xã|xa|thị trấn|thi tran|quận|quan)\s+/i, ""))
        .catch(() => ""));
    }
    return geoCache.get(key);
  }

  // Same file → same fingerprint, used to skip photos that are already uploaded
  async function fingerprint(file) {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function prepare(file, hash) {
    let exif = {};
    try { exif = (await exifr.parse(file, { gps: true, tiff: true, exif: true })) || {}; } catch {}
    let source = file;
    if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
      if (!window.heic2any) throw new Error("Chưa tải xong bộ đọc HEIC, thử lại sau vài giây.");
      source = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
    }
    const bitmap = await createImageBitmap(source);
    const bitmapW = bitmap.width, bitmapH = bitmap.height;
    const [full, thumb] = await Promise.all([resize(bitmap, 2560, "image/jpeg", 0.88), resize(bitmap, 480, "image/webp", 0.8)]);
    bitmap.close();
    const lat = exif.latitude ?? null, lng = exif.longitude ?? null;
    const date = exif.DateTimeOriginal || exif.CreateDate || (file.lastModified ? new Date(file.lastModified) : null);
    return {
      hash,
      name: file.name.replace(/\.(heic|heif|png|webp|avif)$/i, ".jpg"),
      preview: URL.createObjectURL(thumb.blob),
      full, thumb, lat, lng,
      province: lat != null ? provinceAt(lat, lng) || ABROAD : "",
      place: lat != null ? await placeName(lat, lng) : "",
      takenAt: date instanceof Date && !isNaN(date) ? localDay(date) : "",
      camera: [exif.Make, exif.Model].filter(Boolean).join(" ").replace(/^(\w+) \1/i, "$1").trim(),
      // Everything else from the file, for the detail view
      exif: {
        time: date instanceof Date && !isNaN(date) ? date.toLocaleString("vi-VN") : "",
        lens: exif.LensModel || "",
        iso: exif.ISO || "",
        aperture: exif.FNumber ? `f/${exif.FNumber}` : "",
        shutter: exif.ExposureTime ? (exif.ExposureTime < 1 ? `1/${Math.round(1 / exif.ExposureTime)}s` : `${exif.ExposureTime}s`) : "",
        focal: exif.FocalLength ? `${Math.round(exif.FocalLength)}mm` : "",
        size: `${bitmapW}×${bitmapH} · ${(file.size / 1048576).toFixed(1)} MB`,
        gpsPlace: lat != null ? await placeName(lat, lng) : "",
        gpsProvince: lat != null ? provinceAt(lat, lng) || ABROAD : "",
        altitude: exif.GPSAltitude ? `${Math.round(exif.GPSAltitude)} m` : "",
      },
    };
  }

  // Open the dialog first: pick the place, then drop or choose photos
  function openUpload() {
    pending = [];
    if ($("upProvince").options.length < 2) provinceOptions($("upProvince"), "", "Chưa rõ nơi");
    $("upProvince").value = selected && provinces.includes(selected) ? selected : "";
    $("upSummary").textContent = "";
    $("uploadList").replaceChildren();
    $("upProgress").hidden = true;
    $("uploadGo").textContent = "Tải lên";
    $("uploadGo").disabled = true;
    $("uploadDlg").showModal();
  }
  // ---------- "+ Thêm": one place to add a photo, a place, a plan or a visited province ----------
  let addMode = "";
  function openAdd() {
    $("addTitle").textContent = "Thêm mới";
    $("addChoices").hidden = false;
    $("addSpot").hidden = true;
    $("addDlg").showModal();
  }
  function showSpot(mode) {
    addMode = mode;
    $("addTitle").textContent = "Thêm địa điểm đã đi";
    $("addChoices").hidden = true;
    $("addSpot").hidden = false;
    // Places belong to a province (preset to the one open on the map)
    $("addProvince").hidden = mode !== "place";
    if ($("addProvince").options.length < 2) provinceOptions($("addProvince"), "", "Tỉnh: tự nhận theo vị trí");
    $("addProvince").value = provinces.includes(selected) ? selected : "";
    $("addQuery").value = "";
    $("addResults").replaceChildren();
    $("addQuery").focus();
  }
  document.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => {
    const what = b.dataset.add;
    if (what === "photo") { $("addDlg").close(); return openUpload(); }
    if (what === "province") { $("addDlg").close(); return openVisited(); }
    if (what === "place") { $("addDlg").close(); return editPlace(null, { province: provinces.includes(selected) ? selected : "" }); }
    showSpot(what);
  }));
  $("addBack").onclick = openAdd;

  // Found or pasted → a place opens its details form, a plan is saved straight away
  function addSpot({ name, lat, lng, province, url }) {
    $("addDlg").close();
    editPlace(null, { name, lat, lng, url: url || "", province: $("addProvince").value || province || "" });
  }
  async function addSearch() {
    const q = $("addQuery").value.trim();
    if (!q) return;
    const out = $("addResults");
    out.replaceChildren(el("p", { className: "muted small", textContent: "Đang tìm…" }));
    if (isMapsUrl(q)) {
      let full = q;
      if (/goo\.gl/.test(q)) {
        try { full = (await api(`/api/resolve?u=${encodeURIComponent(q)}`)).url; } catch (err) { return out.replaceChildren(el("p", { className: "muted small", textContent: err.message })); }
      }
      const pos = parseMaps(full);
      return addSpot({ name: pos.name, lat: pos.lat, lng: pos.lng, url: q, province: pos.lat != null ? provinceAt(pos.lat, pos.lng) || "" : "" });
    }
    const only = addMode === "place" ? $("addProvince").value : "";
    const found = (await searchSpots(q)).filter((r) => r.province && (!only || r.province === only)).slice(0, 6);
    const plain = el("button", { type: "button", className: "link", textContent: `Thêm "${q}" không ghim vị trí` });
    plain.onclick = () => addSpot({ name: q, lat: null, lng: null, province: only });
    out.replaceChildren(...found.map((r) => {
      const b = el("button", { type: "button" }, el("span", { textContent: r.label }), el("small", { textContent: r.province }));
      b.onclick = () => addSpot({ name: q, lat: r.lat, lng: r.lng, province: r.province });
      return b;
    }), ...(found.length ? [] : [el("p", { className: "muted small", textContent: `Không thấy "${q}"${only ? ` ở ${only}` : ""}.` })]), plain);
  }
  $("addSearch").onclick = addSearch;
  $("addQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSearch(); } });
  $("addBtn").onclick = openAdd;
  const zone = $("dropZone");
  zone.onclick = () => $("fileInput").click();
  zone.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("fileInput").click(); } };
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add("over"); };
  zone.ondragleave = () => zone.classList.remove("over");
  $("fileInput").onchange = (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    handleFiles(files);
  };

  // Drag photos anywhere on the page (manage mode, Drive connected)
  let dragDepth = 0;
  const canDrop = (e) => !$("addBtn").closest("[hidden]") && [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (!canDrop(e)) return; e.preventDefault(); dragDepth++; $("dropOverlay").hidden = false; });
  window.addEventListener("dragover", (e) => { if (canDrop(e)) e.preventDefault(); });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropOverlay").hidden = true; } });
  window.addEventListener("drop", (e) => {
    if (!canDrop(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $("dropOverlay").hidden = true;
    handleFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name)));
  });

  // Add photos to the open dialog (more can be dropped before uploading)
  async function handleFiles(files) {
    if (!files.length) return;
    zone.classList.remove("over");
    if (!$("uploadDlg").open) openUpload();
    if (pending.length && pending.every((p) => p.done)) { pending = []; $("uploadList").replaceChildren(); $("upProgress").hidden = true; $("uploadGo").textContent = "Tải lên"; }
    $("uploadGo").disabled = true; // until every photo is read
    // Skip files already in the album, and repeats inside this batch
    const known = new Set([...photos, ...pending].map((p) => p.hash).filter(Boolean));
    let skipped = 0, done = 0;
    const note = $("upSummary");
    // iPhone HEIC photos are converted in the browser, which takes a while: say so
    const heic = files.filter((f) => /heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name)).length;
    const reading = () => `Đang đọc ảnh ${done}/${files.length}…${heic ? ` (chuyển ${heic} ảnh HEIC, hơi lâu)` : ""}`;
    note.textContent = reading();
    const ready = await pool(files, Math.max(2, Math.min(6, navigator.hardwareConcurrency || 4)), async (f) => {
      try {
        const hash = await fingerprint(f);
        if (known.has(hash)) { skipped++; return null; }
        known.add(hash);
        return await prepare(f, hash);
      } catch (err) { toast(`${f.name}: ${err.message}`); return null; }
      finally { done++; note.textContent = reading(); }
    });
    pending.push(...ready.filter(Boolean));
    if (skipped) toast(`Bỏ qua ${skipped} ảnh đã có trong album`, 3000);
    renderPending(skipped);
  }

  // Simple review: every photo keeps its own date/GPS; one province for photos without GPS
  function renderPending(skipped = 0) {
    $("upSummary").textContent = !pending.length ? (skipped ? "Tất cả ảnh đã có trong album." : "") : `${pending.length} ảnh`
      + (skipped ? ` · bỏ qua ${skipped} ảnh trùng` : "");
    $("uploadList").replaceChildren(...pending.map((p) => {
      p.box = el("div", { className: "up-item", title: [p.place, p.province, p.takenAt].filter(Boolean).join(" · ") },
        el("img", { src: p.preview, alt: "" }),
        el("span", { textContent: p.place || p.province || "" }));
      return p.box;
    }));
    $("uploadGo").disabled = !pending.length;
  }

  const UPLOAD_LIMIT = 6; // photos in flight at once (each sends full + thumbnail in parallel)
  // XHR instead of fetch so upload progress can be shown
  const sendOnce = (blob, name, type, extra, onProgress) => new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", new File([blob], name, { type }));
    for (const [k, v] of Object.entries(extra)) fd.append(k, v || "");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/api/upload`);
    xhr.setRequestHeader("x-admin-key", adminKey);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      xhr.status < 300 && data.id ? (onProgress(blob.size), resolve(data.id)) : reject(new Error(data.error || `Lỗi ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Mất kết nối khi tải lên."));
    xhr.send(fd);
  });
  // Up to 3 tries with a short pause, so a flaky connection does not fail the photo
  async function sendFile(...args) {
    for (let attempt = 1; ; attempt++) {
      try { return await sendOnce(...args); }
      catch (err) {
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  $("uploadGo").onclick = async () => {
    const todo = pending.filter((p) => !p.done);
    // The chosen place decides where photos are saved; without a choice, use the GPS province (or Other)
    const chosen = $("upProvince").value;
    for (const p of todo) {
      p.province = chosen || p.exif.gpsProvince || "";
      p.place = p.province === p.exif.gpsProvince ? p.exif.gpsPlace : "";
    }
    $("uploadGo").disabled = true;
    const t0 = performance.now();
    const total = todo.reduce((n, p) => n + p.full.blob.size + p.thumb.blob.size, 0);
    const sent = new Map();
    let finished = 0;
    const paint = () => {
      const bytes = [...sent.values()].reduce((a, b) => a + b, 0);
      const pct = Math.min(99, Math.round((bytes / total) * 100));
      $("upBar").style.width = `${pct}%`;
      $("upText").textContent = pct >= 99 ? `Đang lưu lên Google Drive… (${finished}/${todo.length} ảnh xong)` : `Đang tải lên ${finished}/${todo.length} ảnh · ${pct}%`;
    };
    $("upProgress").hidden = false;
    $("upText").textContent = "Đang chuẩn bị thư mục trên Drive…";
    try {
      const groups = [...new Map(todo.map((p) => [`${p.province}|${(p.takenAt || "").slice(0, 4)}`, { province: p.province, takenAt: p.takenAt }])).values()];
      await api("/api/folders", jsonBody("POST", { groups }));
    } catch (err) { toast(err.message); }
    paint();
    // 1) files to Drive, several photos at once (full + thumbnail in parallel per photo)
    await pool(todo, UPLOAD_LIMIT, async (p) => {
      p.box.className = "up-item";
      try {
        const track = (key) => (n) => { sent.set(key, n); paint(); };
        const [fileId, thumbId] = await Promise.all([
          p.fileId || sendFile(p.full.blob, p.name, "image/jpeg", { province: p.province, takenAt: p.takenAt, place: p.place }, track(p.name + "f")),
          p.thumbId || sendFile(p.thumb.blob, p.name.replace(/\.\w+$/, ".webp"), "image/webp", { kind: "thumb" }, track(p.name + "t")),
        ]);
        Object.assign(p, { fileId, thumbId });
        finished++;
        paint();
      } catch (err) {
        p.box.className = "up-item err";
        p.box.title = err.message;
      }
    });
    // 2) add them all to the list in one request
    const uploaded = todo.filter((p) => p.fileId && p.thumbId);
    $("upText").textContent = `Đang lưu ${uploaded.length} ảnh vào bản đồ…`;
    if (uploaded.length) {
      try {
        const added = await api("/api/photos", jsonBody("POST", { items: uploaded.map((p) => ({
          fileId: p.fileId, thumbId: p.thumbId, name: p.name, width: p.full.width, height: p.full.height, hash: p.hash,
          camera: p.camera, exif: p.exif, province: p.province, place: p.place || "", takenAt: p.takenAt, title: "", lat: p.lat, lng: p.lng,
        })) }));
        setPhotos([...photos, ...kids, ...added]);
        for (const p of uploaded) { p.done = true; p.box.className = "up-item ok"; }
      } catch (err) {
        for (const p of uploaded) { p.box.className = "up-item err"; p.box.title = err.message; }
      }
    }
    renderAll();
    const ok = todo.filter((p) => p.done).length;
    const failed = pending.filter((p) => !p.done).length;
    $("uploadGo").disabled = false;
    $("uploadGo").textContent = failed ? `Tải lại ${failed} ảnh lỗi` : "Tải lên";
    $("upBar").style.width = "100%";
    $("upText").textContent = failed ? `Xong ${ok}/${todo.length} ảnh · ${failed} ảnh lỗi, bấm "Tải lại" để thử tiếp` : `✓ Xong ${ok}/${todo.length} ảnh`;
    toast(`✓ Đã tải lên ${ok}/${todo.length} ảnh trong ${((performance.now() - t0) / 1000).toFixed(1)} giây`);
    if (!failed) setTimeout(() => $("uploadDlg").close(), 800);
  };

  // ---------- start ----------
  async function start() {
    // Map shapes, album data and the admin check all load at the same time
    const dataP = Promise.all([
      api("/api/photos"),
      api("/api/visited").catch(() => []),
      api("/api/meta").catch(() => ({ trips: {}, covers: {} })),
      api("/api/places").catch(() => []),
      loadPlans().catch(() => []),
    ]);
    dataP.catch(() => {});
    const adminP = checkAdmin(false);
    geo = await (await fetch("vn-34.json")).json();
    provinces = geo.features.map((f) => f.properties.name).sort((a, b) => a.localeCompare(b, "vi"));
    provinceOptions($("selProvince"), "", "Chọn tỉnh…");
    provinceOptions($("moveProvince"), "", "Chưa rõ nơi");
    initMap();
    try {
      const loaded = await dataP;
      [, manual, meta, places, plans] = loaded;
      setPhotos(loaded[0]);
    } catch (err) {
      toast(`Không tải được ảnh: ${err.message}`);
    }
    await adminP;
    // Put back what was open last time before the first paint, so nothing jumps
    if (ui.year && photos.some((p) => (p.takenAt || "").startsWith(ui.year))) year = ui.year;
    renderAll();
    $("loading").hidden = true;
  }
  start();
})();
