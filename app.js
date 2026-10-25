// Hoang's Memories — travel map of Vietnam (34 provinces, 2025) with photo milestones.
// Photos and their metadata are served by the Cloudflare Worker in worker/ (Google Drive behind it).
(() => {
  const API = "https://memories-api.hoangpham2263.workers.dev";
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

  let photos = [];
  let year = ""; // year filter, "" = all
  // Photos of the chosen year (all when no filter): what the map, trips, stats and timeline show
  const shown = () => (year ? photos.filter((p) => (p.takenAt || "").startsWith(year)) : photos);
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

  // Public photos load straight from the Worker; private ones need the admin key, so they are fetched as blobs
  const blobCache = new Map();
  function setImg(img, p, size) {
    const url = `${API}/api/img/${p.id}${size ? `?size=${size}` : ""}`;
    if (!p.private) { img.src = url; return; }
    if (!blobCache.has(url)) {
      blobCache.set(url, fetch(url, { headers: { "x-admin-key": adminKey || "" } }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : "")));
    }
    blobCache.get(url).then((src) => { if (src) img.src = src; });
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

  // ---------- trips ----------
  // Consecutive photos in the same province, at most TRIP_GAP_DAYS apart, form one trip
  function computeTrips() {
    const dated = shown().filter((p) => p.takenAt && p.province).sort((a, b) => a.takenAt.localeCompare(b.takenAt));
    const trips = [];
    let cur = null;
    for (const p of dated) {
      const gap = cur ? (new Date(p.takenAt) - new Date(cur.end)) / 86400000 : Infinity;
      if (cur && cur.province === p.province && gap <= TRIP_GAP_DAYS) {
        cur.photos.push(p);
        cur.end = p.takenAt;
      } else {
        cur = { province: p.province, start: p.takenAt, end: p.takenAt, photos: [p] };
        trips.push(cur);
      }
    }
    for (const t of trips) {
      t.key = `${slug(t.province)}-${t.start}`;
      const m = meta.trips[t.key] || {};
      t.places = [...new Set(t.photos.map((p) => p.place).filter(Boolean))];
      t.name = m.name || t.province;
      t.note = m.note || "";
      t.cover = t.photos.find((p) => p.id === m.cover) || t.photos[0];
    }
    // Most recent trip first
    return trips.sort((a, b) => b.end.localeCompare(a.end));
  }
  const tripRange = (t) => {
    const a = new Date(t.start), b = new Date(t.end);
    if (t.start === t.end) return fmtDate(t.start);
    if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return `${a.getDate()}–${fmtDate(t.end)}`;
    return `${fmtDate(t.start)} – ${fmtDate(t.end)}`;
  };
  const coverOf = (province) => {
    const list = byProvince().get(province) || [];
    return list.find((p) => p.id === meta.covers[province]) || newestFirst(list)[0];
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
    map = L.map("map", { zoomControl: false, attributionControl: false, zoomSnap: 0.25, minZoom: 4.5, maxZoom: 13, scrollWheelZoom: false, touchZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, dragging: !L.Browser.mobile });
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
      m.bindTooltip(`Sắp đi: ${x.name}`, { className: "tip", direction: "top" });
      grow(m);
      placeLayer.addLayer(m);
    }
    for (const x of places) {
      if (x.lat == null || x.lng == null) continue;
      const m = L.circleMarker([x.lat, x.lng], { pane: "dots", radius: DOT, color: cssVar("--muted"), weight: 1, fillColor: cssVar("--bg"), fillOpacity: 1 });
      m.bindTooltip(x.name, { className: "tip", direction: "top" });
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

  function selectProvince(name) {
    selected = name;
    layer.setStyle(styleFor);
    raiseSelected();
    renderSide();
  }

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
    const img = lazyImg(first, { alt: p.title || "" });
    setImg(img, p, "thumb");
    const b = el("button", { type: "button", className: "thumb", title: p.title || p.place || p.province || "" }, img,
      p.private ? el("span", { className: "lock", textContent: "🔒" }) : null);
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
    try { places = await api("/api/places", jsonBody("PUT", { places: next })); renderAll(); toast(msg); }
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

  // ---------- places to go next ----------
  async function savePlans(next, msg) {
    try { plans = await api("/api/plans", jsonBody("PUT", { places: next })); renderAll(); toast(msg); }
    catch (err) { toast(err.message); }
  }
  const monthText = (m) => (m ? `${+m.slice(5)}/${m.slice(0, 4)}` : "");
  function renderPlans() {
    // Soonest planned month first, places without a date last
    const sorted = [...plans].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
    const chips = el("div", { className: "chip-row" }, ...sorted.map((x) => {
      const chip = el("span", { className: "chip plan" }, el("span", { textContent: x.name }),
        x.date || x.province ? el("small", { textContent: [monthText(x.date), x.province].filter(Boolean).join(" · ") }) : null);
      if (admin) {
        const done = el("button", { type: "button", textContent: "✓", title: "Đã đi: chuyển sang nơi đã đến" });
        done.onclick = async () => {
          try {
            [places, plans] = await Promise.all([
              api("/api/places", jsonBody("PUT", { places: [...places, x] })),
              api("/api/plans", jsonBody("PUT", { places: plans.filter((y) => y !== x) })),
            ]);
            renderAll();
            toast(`✓ Đã đi ${x.name}`);
          } catch (err) { toast(err.message); }
        };
        const del = el("button", { type: "button", textContent: "✕", title: "Bỏ" });
        del.onclick = () => savePlans(plans.filter((y) => y !== x), `Đã bỏ ${x.name}`);
        chip.append(done, del);
      }
      return chip;
    }));
    if (!admin) return $("plans").replaceChildren(chips);
    const input = el("input", { placeholder: "Thêm nơi muốn đi, vd: Phú Quốc, Sa Pa…", autocomplete: "off" });
    const go = el("button", { type: "button", textContent: "Tìm" });
    const when = el("input", { type: "month", title: "Dự định đi (không bắt buộc)", "aria-label": "Dự định đi" });
    const results = el("div", { className: "place-results" });
    const search = async () => {
      const q = input.value.trim();
      if (!q) return;
      results.replaceChildren(el("p", { className: "muted small", textContent: "Đang tìm…" }));
      const found = (await searchSpots(q)).filter((r) => r.province).slice(0, 5);
      const plain = el("button", { type: "button", className: "link", textContent: `Thêm "${q}" không ghim vị trí` });
      plain.onclick = () => savePlans([...plans, { name: q, province: "", lat: null, lng: null, date: when.value || null }], `✓ Đã thêm ${q}`);
      results.replaceChildren(...found.map((r) => {
        const b = el("button", { type: "button" }, el("span", { textContent: r.label }), el("small", { textContent: r.province }));
        b.onclick = () => savePlans([...plans, { name: q, province: r.province, lat: r.lat, lng: r.lng, date: when.value || null }], `✓ Đã thêm ${q}`);
        return b;
      }), ...(found.length ? [] : [el("p", { className: "muted small", textContent: `Không thấy "${q}".` })]), plain);
    };
    go.onclick = search;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
    $("plans").replaceChildren(...[plans.length ? chips : null, el("div", { className: "place-add plan-add" }, input, go, el("label", { className: "plan-when" }, el("span", { textContent: "Tháng dự định" }), when)), results].filter(Boolean));
  }

  $("settingsBtn").onclick = () => $("settingsDlg").showModal();
  // Click outside a dialog (on the dark overlay) closes it, except while photos are uploading
  document.querySelectorAll("dialog.dlg").forEach((d) => d.addEventListener("click", (e) => {
    if (e.target === d && !(d.id === "uploadDlg" && $("uploadGo").disabled && !$("upProgress").hidden)) d.close();
  }));
  // Menu shortcuts to the map actions (phones)
  document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => { $("settingsDlg").close(); $(b.dataset.go).click(); }));
  $("plansBtn").onclick = () => { renderPlans(); $("plansDlg").showModal(); };

  // ---------- places: areas, notes, Google Maps ----------
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
  function placeRow(x) {
    const link = el("a", { className: "place-map", href: mapsLink(x), target: "_blank", rel: "noopener", title: "Mở Google Maps", textContent: "Maps ↗" });
    const body = el("span", { className: "place-body" },
      el("span", { className: "place-name", textContent: `${KINDS[x.kind] || "•"} ${x.name}` }),
      x.note ? el("small", { textContent: x.note }) : null);
    const row = el(admin ? "button" : "div", { className: "place-row", ...(admin ? { type: "button", title: "Sửa" } : {}) }, body, link);
    if (admin) row.onclick = (e) => { if (!e.target.closest("a")) editPlace(x); };
    return row;
  }
  function placeTree(spots) {
    return el("div", { className: "place-tree" }, ...byArea(spots).map(([area, list]) =>
      el("div", { className: "place-area" },
        el("p", { className: "place-area-name", textContent: area || (spots.some((x) => x.group) ? "Khác" : "Địa điểm") }),
        ...list.map(placeRow))));
  }

  // Add / edit one place in a dialog
  let editing = null; // { place (null = new), draft }
  function editPlace(x, draft) {
    editing = { place: x || null, draft: draft || x };
    const d = editing.draft, f = $("placeForm");
    $("placeDlgTitle").textContent = x ? "Sửa địa điểm" : `Thêm địa điểm · ${d.province || OTHER}`;
    f.name.value = d.name || "";
    f.group.value = d.group || "";
    f.kind.value = d.kind || "";
    f.note.value = d.note || "";
    f.url.value = d.url || "";
    $("groupList").replaceChildren(...[...new Set(places.filter((y) => y.province === d.province).map((y) => y.group).filter(Boolean))].map((g) => el("option", { value: g })));
    $("placeDelete").hidden = !x;
    $("placeDlg").showModal();
  }
  $("placeSave").onclick = async () => {
    const f = $("placeForm");
    const name = f.name.value.trim();
    if (!name) return toast("Nhập tên địa điểm");
    let { lat, lng, province } = editing.draft;
    const url = f.url.value.trim();
    // A pasted Maps link can also give the position
    if (url && url !== editing.draft.url && isMapsUrl(url)) {
      const pos = parseMaps(/goo\.gl/.test(url) ? (await api(`/api/resolve?u=${encodeURIComponent(url)}`).catch(() => ({ url })) ).url : url);
      if (pos.lat != null) ({ lat, lng } = pos);
    }
    const item = { ...editing.draft, name, group: f.group.value.trim(), kind: f.kind.value, note: f.note.value.trim(), url: isMapsUrl(url) ? url : "", lat, lng, province };
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

  // Side panel of a province: places by area, plus search / paste a Google Maps link to add
  function placeBox(province, spots) {
    const tree = spots.length ? placeTree(spots) : null;
    if (!admin) return tree;
    const input = el("input", { placeholder: `Tìm hoặc dán link Google Maps…`, autocomplete: "off" });
    const go = el("button", { type: "button", textContent: "Thêm" });
    const results = el("div", { className: "place-results" });
    const search = async () => {
      const q = input.value.trim();
      if (!q) return;
      results.replaceChildren(el("p", { className: "muted small", textContent: "Đang tìm…" }));
      if (isMapsUrl(q)) {
        let full = q;
        if (/goo\.gl/.test(q)) {
          try { full = (await api(`/api/resolve?u=${encodeURIComponent(q)}`)).url; } catch (err) { return results.replaceChildren(el("p", { className: "muted small", textContent: err.message })); }
        }
        const pos = parseMaps(full);
        results.replaceChildren();
        input.value = "";
        return editPlace(null, { name: pos.name, lat: pos.lat, lng: pos.lng, url: q, province: pos.lat != null ? provinceAt(pos.lat, pos.lng) || province : province });
      }
      // Only results inside this province
      const found = (await searchSpots(q)).filter((r) => r.province === province).slice(0, 5);
      const pick = (lat, lng) => { results.replaceChildren(); input.value = ""; editPlace(null, { name: q, lat, lng, province }); };
      const plain = el("button", { type: "button", className: "link", textContent: `Thêm "${q}" không ghim vị trí` });
      plain.onclick = () => pick(null, null);
      results.replaceChildren(...found.map((r) => {
        const b = el("button", { type: "button", textContent: r.label });
        b.onclick = () => pick(r.lat, r.lng);
        return b;
      }), ...(found.length ? [] : [el("p", { className: "muted small", textContent: `Không thấy "${q}" ở ${province}.` })]), plain);
    };
    go.onclick = search;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
    return el("div", { className: "place-box" }, tree, el("div", { className: "place-add" }, input, go), results);
  }

  // ---------- overview: province → area → place ----------
  function renderOverview() {
    const visited = [...visitedSet()].sort((a, b) => a.localeCompare(b, "vi"));
    const photosBy = byProvince();
    $("overviewCard").hidden = !visited.length;
    $("overviewCount").textContent = visited.length ? `${visited.length} tỉnh · ${places.length} địa điểm` : "";
    $("overview").replaceChildren(...visited.map((name) => {
      const spots = placesIn(name);
      const n = photosBy.get(name)?.length || 0;
      const sum = el("summary", {},
        el("i", { style: `background:${colorOf(name)}` }),
        el("span", { textContent: name }),
        el("small", { textContent: [spots.length ? `${spots.length} địa điểm` : "", n ? `${n} ảnh` : ""].filter(Boolean).join(" · ") || "Đã đến" }));
      const open = el("button", { type: "button", className: "link", textContent: "Xem trên bản đồ" });
      open.onclick = () => { selectProvince(name); document.querySelector(".map-card").scrollIntoView({ behavior: "smooth", block: "start" }); };
      return el("details", { className: "ov-prov" }, sum, el("div", { className: "ov-body" }, spots.length ? placeTree(spots) : null, open));
    }));
  }

  function renderSide() {
    const groups = byProvince();
    $("sideBack").hidden = !selected;
    if (selected && provinces.concat(ABROAD).includes(selected)) {
      const list = newestFirst(groups.get(selected) || []);
      albumList = list;
      $("sideTitle").textContent = `${selected} · ${list.length} ảnh`;
      const ticked = visitedSet().has(selected);
      const spots = placesIn(selected);
      $("sideBody").replaceChildren(...[
        spots.length || admin ? placeBox(selected, spots) : null,
        list.length ? albumGrid(list, selected) : ticked || spots.length ? null : el("p", { className: "empty", textContent: "Chưa có ảnh." }),
      ].filter(Boolean));
      return;
    }
    if (selected === OTHER) return showList(OTHER, newestFirst(shown().filter((p) => !p.province)));
    selected = null;
    $("sideTitle").textContent = "Nơi đã đến";
    const rows = [...groups.entries()].filter(([n]) => n !== ABROAD).sort((a, b) => b[1].length - a[1].length);
    for (const n of visitedSet()) if (!groups.has(n)) rows.push([n, []]);
    if (groups.get(ABROAD)) rows.push([ABROAD, groups.get(ABROAD)]);
    const other = shown().filter((p) => !p.province);
    if (other.length) rows.push([OTHER, other]);
    if (!rows.length) return $("sideBody").replaceChildren(el("p", { className: "empty", textContent: "Chưa có nơi nào." }));
    const row = ([name, list]) => {
      const cover = name === OTHER ? null : coverOf(name);
      const icon = cover ? lazyImg(true, { className: "prov-cover", alt: "" }) : el("i", { style: `background:${name === OTHER || name === ABROAD ? cssVar("--muted") : colorOf(name)}` });
      if (cover) setImg(icon, cover, "thumb");
      const b = el("button", { type: "button", className: "prov" }, icon,
        el("span", { textContent: name }),
        el("small", { textContent: list.length ? `${list.length} ảnh` : placesIn(name).length ? `${placesIn(name).length} địa điểm` : "Đã đến" }));
      b.onclick = () => (name === OTHER ? showList(OTHER, newestFirst(list)) : selectProvince(name));
      return b;
    };
    // 10 places a page on phones
    $("sideBody").replaceChildren(paged(rows, 10, "places", (part) => el("div", { className: "prov-list" }, ...part.map(row))));
  }

  // Photos of the album open in the side panel (province / trip / Other); "Chọn tất cả" picks these
  let albumList = null;
  const albumPhotos = () => (selected && albumList ? albumList : shown());

  // Keep page scroll working over the side list until the list itself has something to scroll
  const sideBody = $("sideBody");
  const markScroll = () => {
    // Album open: places + search stick to the top while the photos scroll
    sideBody.classList.toggle("album", !!sideBody.querySelector(":scope > .grid"));
    sideBody.classList.toggle("scrolls", sideBody.scrollHeight > sideBody.clientHeight + 1);
    if (selecting) renderSelBar(); // "Chọn cả …" follows the album on screen
  };
  new ResizeObserver(markScroll).observe(sideBody);
  new MutationObserver(markScroll).observe(sideBody, { childList: true });

  // Phones: the album shows 20 photos a page (4 × 5) with ‹ › instead of a scroll area (nested scrolling jumps on iOS)
  const isPhone = () => matchMedia("(max-width: 640px)").matches;
  const PAGE = 20; // 4 columns × 5 rows
  // Phones: long lists split into numbered pages; render(slice) draws one page
  const pageAt = {}; // current page per list key
  function paged(items, per, key, render) {
    if (!isPhone() || items.length <= per) return render(items, 0);
    const pages = Math.ceil(items.length / per);
    pageAt[key] = Math.min(pageAt[key] || 0, pages - 1);
    const wrap = el("div", { className: "album-pages" });
    const draw = () => {
      const cur = pageAt[key];
      const btn = (label, n, props = {}) => {
        const b = el("button", { type: "button", textContent: label, ...props });
        b.onclick = () => { pageAt[key] = n; draw(); };
        return b;
      };
      // Numbered pages: first, last and the ones next to the current page, "…" for the gaps
      const nums = [];
      for (let i = 0; i < pages; i++) {
        if (i === 0 || i === pages - 1 || Math.abs(i - cur) <= 1) nums.push(i);
        else if (nums.at(-1) !== "…") nums.push("…");
      }
      wrap.replaceChildren(render(items.slice(cur * per, cur * per + per), cur * per), el("div", { className: "pager" },
        btn("‹", cur - 1, { disabled: cur === 0, ariaLabel: "Trang trước" }),
        ...nums.map((n) => (n === "…" ? el("span", { textContent: "…" }) : btn(String(n + 1), n, { className: n === cur ? "on" : "" }))),
        btn("›", cur + 1, { disabled: cur >= pages - 1, ariaLabel: "Trang sau" })));
    };
    draw();
    return wrap;
  }
  let albumKey = "";
  function albumGrid(list, key) {
    // A different album starts on page 1
    if (albumKey !== key) { albumKey = key; pageAt.album = 0; }
    return paged(list, PAGE, "album", (part, from) =>
      el("div", { className: "grid" }, ...part.map((p, i) => thumbButton(p, list, from + i < 9))));
  }

  function showList(title, list, head) {
    selected = title;
    $("sideBack").hidden = false;
    $("sideTitle").textContent = `${title} · ${list.length} ảnh`;
    albumList = list;
    $("sideBody").replaceChildren(...(head || []), albumGrid(list, title));
  }

  // ---------- trips ----------
  function openTrip(t, scroll = true) {
    selected = t.key;
    layer.setStyle(styleFor);
    const share = el("button", { type: "button", textContent: "Sao chép link" });
    share.onclick = async () => {
      // Link through the Worker's preview page, so chat apps show the cover photo and trip name
      const q = new URLSearchParams({ t: t.key, n: t.name, d: `${tripRange(t)} · ${t.photos.length} ảnh` });
      if (t.cover && !t.cover.private) q.set("c", t.cover.id);
      try { await navigator.clipboard.writeText(`${API}/share?${q}`); toast("✓ Đã sao chép link chuyến đi"); }
      catch { toast("Không sao chép được"); }
    };
    const edit = admin ? el("button", { type: "button", textContent: "Sửa" }) : null;
    if (edit) edit.onclick = () => editTrip(t);
    const head = [
      el("div", { className: "trip-head" },
        el("p", { className: "muted small", textContent: [tripRange(t), t.places.slice(0, 4).join(", ")].filter(Boolean).join(" · ") }),
        t.note ? el("p", { className: "trip-note", textContent: t.note }) : null,
        el("div", { className: "actions" }, edit, share)),
    ];
    showList(t.name, t.photos, head);
    history.replaceState(null, "", `#trip=${t.key}`);
    if (scroll) document.querySelector(".map-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  let editingTrip = null;
  function editTrip(t) {
    editingTrip = t;
    const f = $("tripForm");
    f.name.value = meta.trips[t.key]?.name || "";
    f.name.placeholder = t.province;
    f.note.value = t.note;
    $("tripDlg").showModal();
  }
  $("tripSave").onclick = async () => {
    const t = editingTrip, f = $("tripForm");
    try {
      await saveMeta({ ...meta, trips: { ...meta.trips, [t.key]: { ...(meta.trips[t.key] || {}), name: f.name.value.trim(), note: f.note.value.trim() } } });
      $("tripDlg").close();
      const fresh = computeTrips().find((x) => x.key === t.key);
      if (fresh) openTrip(fresh, false);
      toast("✓ Đã lưu chuyến đi");
    } catch (err) { toast(err.message); }
  };

  function renderTrips() {
    const trips = computeTrips();
    $("tripCount").textContent = trips.length ? `${trips.length} chuyến` : "";
    if (!trips.length) return $("trips").replaceChildren(el("p", { className: "empty", textContent: "Chưa có chuyến đi nào." }));
    $("trips").replaceChildren(...trips.map((t, i) => {
      const img = lazyImg(i < 4, { alt: "" });
      setImg(img, t.cover, "thumb");
      const b = el("button", { type: "button", className: "trip" }, img,
        el("span", { className: "trip-info" },
          el("strong", { textContent: t.name }),
          el("small", { textContent: `${tripRange(t)} · ${t.photos.length} ảnh` })));
      b.onclick = () => openTrip(t);
      return b;
    }));
  }

  // ---------- stats ----------
  function renderStats() {
    const visited = visitedSet();
    const list = shown();
    $("visitedText").textContent = `Đã đến ${visited.size}/34 tỉnh, thành phố · ${list.length} ảnh${year ? ` · năm ${year}` : ""}`;
    // Year chips, only when photos span more than one year
    const years = [...new Set(photos.map((p) => (p.takenAt || "").slice(0, 4)).filter(Boolean))].sort().reverse();
    $("years").hidden = years.length < 2;
    $("years").replaceChildren(...["", ...years].map((y) => {
      const b = el("button", { type: "button", className: y === year ? "on" : "", textContent: y || "Tất cả" });
      b.onclick = () => { year = y; selected = null; renderAll(); };
      return b;
    }));
    $("visitedBar").style.width = `${(visited.size / 34) * 100}%`;
    $("photoCount").textContent = list.length ? `${list.length} ảnh` : "";
    const items = [
      [list.length, "Ảnh"],
      [computeTrips().length, "Chuyến đi"],
      [`${visited.size}/34`, "Tỉnh, thành phố"],
      [places.length, "Địa điểm đã đến"],
      [plans.length, "Nơi sắp đi"],
    ];
    $("stats").replaceChildren(...items.map(([v, label]) => el("div", { className: "stat" }, el("span", { textContent: label }), el("strong", { textContent: v }))));
  }

  // ---------- timeline ----------
  // Long albums: show 60 photos, then 60 more each time the end comes into view
  const TL_STEP = 60;
  let tlLimit = TL_STEP, tlObserver;
  function renderTimeline() {
    tlObserver?.disconnect();
    const all = shown();
    if (!all.length) return $("timeline").replaceChildren(el("p", { className: "empty", textContent: "Chưa có ảnh nào." }));
    const sorted = newestFirst(all);
    const months = new Map();
    for (const p of sorted.slice(0, tlLimit)) {
      const d = new Date(photoDate(p));
      const month = isNaN(d) ? "Không rõ thời gian" : `Tháng ${d.getMonth() + 1}/${d.getFullYear()}`;
      const day = isNaN(d) ? "" : fmtDate(photoDate(p));
      if (!months.has(month)) months.set(month, new Map());
      const days = months.get(month);
      days.set(day, [...(days.get(day) || []), p]);
    }
    $("timeline").replaceChildren(...[...months.entries()].map(([month, days]) =>
      el("div", { className: "tl-month" },
        el("h3", { textContent: month }),
        ...[...days.entries()].map(([day, list]) => {
          const places = [...new Set(list.map((p) => [p.place, p.province].filter(Boolean).join(", ")).filter(Boolean))].join(" · ");
          return el("div", { className: "tl-day" },
            el("p", { className: "tl-day-head" }, el("span", { textContent: day || "Không rõ ngày" }), places ? el("small", { textContent: ` · ${places}` }) : null),
            el("div", { className: "grid" }, ...list.map((p) => thumbButton(p, sorted))));
        }))));
    if (sorted.length > tlLimit) {
      const more = el("div", { className: "tl-more", textContent: `Đang tải thêm… (${tlLimit}/${sorted.length})` });
      $("timeline").append(more);
      tlObserver = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting) return;
        tlLimit += TL_STEP;
        renderTimeline();
      }, { rootMargin: "400px" });
      tlObserver.observe(more);
    }
  }

  function renderAll() {
    renderStats();
    renderSide();
    renderTrips();
    renderPlans();
    renderOverview();
    renderTimeline();
    refreshMap();
  }

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
    const img = $("viewerImg");
    setImg(img, p, "thumb");
    const full = new Image();
    full.onload = () => { if (current() === p) img.src = full.src; };
    setImg(full, p);
    $("viewerImg").alt = p.title || "";
    const where = [p.place, p.province].filter(Boolean).join(", ");
    $("viewerText").replaceChildren(...[
      p.title ? el("p", {}, el("strong", { textContent: p.title })) : null,
      el("p", { className: "muted small", textContent: [where, fmtDate(photoDate(p)), p.camera, p.private ? "🔒 Chỉ mình xem" : ""].filter(Boolean).join(" · ") }),
      p.note ? el("p", { textContent: p.note }) : null,
      photoInfo(p),
    ].filter(Boolean));
    $("viewerPrev").hidden = viewIndex <= 0;
    $("viewerNext").hidden = viewIndex >= viewList.length - 1;
    $("viewerTools").hidden = !admin;
    if (admin) {
      $("moveProvince").value = p.province || "";
      $("pinPlace").hidden = p.lat == null;
      $("coverProvince").hidden = !p.province;
      $("coverTrip").hidden = !computeTrips().some((t) => t.photos.includes(p));
      $("togglePrivate").textContent = p.private ? "Công khai ảnh này" : "Chỉ mình xem";
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
      ["Tên file", p.name],
    ].filter(([, v]) => v);
    if (p.lat != null) rows.push(["Tọa độ", el("a", { href: `https://www.google.com/maps?q=${p.lat},${p.lng}`, target: "_blank", rel: "noopener", textContent: `${(+p.lat).toFixed(5)}, ${(+p.lng).toFixed(5)}` })]);
    if (!rows.length) return null;
    return el("details", { className: "photo-info" }, el("summary", { textContent: "Thông tin ảnh" }),
      el("dl", {}, ...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", {}, v)])));
  }
  const step = (d) => { if (viewList[viewIndex + d]) { viewIndex += d; showViewer(); } };
  $("viewerPrev").onclick = () => step(-1);
  $("viewerNext").onclick = () => step(1);
  $("viewerClose").onclick = () => $("viewer").close();
  $("viewer").addEventListener("click", (e) => { if (e.target.classList.contains("viewer-box")) $("viewer").close(); });
  document.addEventListener("keydown", (e) => {
    if (!$("viewer").open || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });

  const applyUpdate = (updated) => {
    for (const u of [].concat(updated)) {
      const p = photos.find((x) => x.id === u.id);
      if (p) Object.assign(p, u);
    }
  };

  // Change place: pick a province, saved at once (the file moves to that folder on Drive)
  $("moveProvince").onchange = async (e) => {
    try {
      applyUpdate(await api(`/api/photos/${current().id}`, jsonBody("PATCH", { province: e.target.value })));
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
      await api(`/api/photos/${p.id}`, { method: "DELETE" });
      photos = photos.filter((x) => x.id !== p.id);
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
    const t = computeTrips().find((x) => x.photos.includes(p));
    if (!t) return;
    try { await saveMeta({ ...meta, trips: { ...meta.trips, [t.key]: { ...(meta.trips[t.key] || {}), cover: p.id } } }); toast("✓ Đã đặt ảnh bìa chuyến đi"); }
    catch (err) { toast(err.message); }
  };
  $("togglePrivate").onclick = async () => {
    const p = current();
    try {
      applyUpdate(await api(`/api/photos/${p.id}`, jsonBody("PATCH", { private: !p.private })));
      renderAll();
      showViewer();
      toast(p.private ? "🔒 Ảnh chỉ mình bạn xem được" : "✓ Ảnh đã công khai");
    } catch (err) { toast(err.message); }
  };

  // ---------- multi-select ----------
  function renderSelBar() {
    $("selBar").hidden = !selecting;
    $("selCount").textContent = `Đã chọn ${picked.size} ảnh`;
    for (const id of ["selMove", "selPrivate", "selPublic", "selDownload", "selDelete"]) $(id).disabled = !picked.size;
    $("selDownload").textContent = picked.size > 1 ? `Tải ${picked.size} ảnh` : "Tải về";
    const scope = albumPhotos();
    const all = scope.length && scope.every((p) => picked.has(p.id));
    $("selAll").textContent = all ? "Bỏ chọn" : selected ? `Chọn cả ${selected}` : "Chọn tất cả";
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
    const ids = [...picked];
    try {
      const res = await api("/api/photos/batch", jsonBody("POST", { action, ids, changes }));
      if (action === "delete") photos = photos.filter((p) => !picked.has(p.id));
      else applyUpdate(res);
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
    if (!province && !confirm("Chưa chọn tỉnh: các ảnh sẽ chuyển vào Other. Tiếp tục?")) return;
    batch("update", { province });
  };
  $("selPrivate").onclick = () => batch("update", { private: true });
  $("selPublic").onclick = () => batch("update", { private: false });
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
    renderPlans();
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
    if (!wasAdmin && reload) { try { photos = await api("/api/photos"); renderAll(); } catch {} }
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
    photos = photos.filter((p) => !p.private);
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
      const next = await Promise.all([api("/api/photos"), api("/api/visited"), api("/api/meta"), api("/api/places"), api("/api/plans")]);
      if (JSON.stringify(next) === JSON.stringify([photos, manual, meta, places, plans])) return;
      [photos, manual, meta, places, plans] = next;
      renderAll();
    } catch {}
  }
  window.addEventListener("focus", () => { if (adminKey) checkAdmin(); syncData(); });

  // ---------- backup ----------
  // ---------- download ----------
  const fileName = (p) => [p.takenAt, p.name || `${p.id}.jpg`].filter(Boolean).join(" ");
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
  $("selDownload").onclick = () => downloadPhotos(photos.filter((p) => picked.has(p.id)), `memories-${picked.size}-anh-${today()}.zip`);
  $("backupZip").onclick = () => downloadPhotos(photos, `memories-album-${today()}.zip`, JSON.stringify({ photos, visited: manual, places, plans, meta }, null, 2));

  // ---------- places visited without photos ----------
  async function saveManual(list) {
    try {
      manual = await api("/api/visited", jsonBody("PUT", { provinces: list }));
      renderAll();
      toast("✓ Đã lưu nơi đã đến");
    } catch (err) { toast(err.message); }
  }
  $("visitedBtn").onclick = () => {
    const withPhotos = byProvince();
    $("visitedList").replaceChildren(...provinces.map((n) => {
      const has = withPhotos.has(n);
      const box = el("input", { type: "checkbox", value: n, checked: has || manual.includes(n), disabled: has });
      return el("label", { className: "vis-item", title: has ? "Đã có ảnh" : "" }, box, el("span", { textContent: n }));
    }));
    $("visitedDlg").showModal();
  };
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
    if ($("upProvince").options.length < 2) provinceOptions($("upProvince"), "", "Other (không chọn tỉnh)");
    $("upProvince").value = selected && provinces.includes(selected) ? selected : "";
    $("upSummary").textContent = "";
    $("uploadList").replaceChildren();
    $("upProgress").hidden = true;
    $("uploadGo").textContent = "Tải lên";
    $("uploadGo").disabled = true;
    $("uploadDlg").showModal();
  }
  $("addBtn").onclick = openUpload;
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
        photos.push(...added);
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
      api("/api/plans").catch(() => []),
    ]);
    dataP.catch(() => {});
    const adminP = checkAdmin(false);
    geo = await (await fetch("vn-34.json")).json();
    provinces = geo.features.map((f) => f.properties.name).sort((a, b) => a.localeCompare(b, "vi"));
    provinceOptions($("selProvince"), "", "Chọn tỉnh…");
    provinceOptions($("moveProvince"), "", "Other");
    initMap();
    try {
      [photos, manual, meta, places, plans] = await dataP;
    } catch (err) {
      toast(`Không tải được ảnh: ${err.message}`);
    }
    await adminP;
    renderAll();
    $("sideBack").onclick = () => {
      selected = null;
      history.replaceState(null, "", location.pathname);
      renderAll();
    };
    // Shared trip link: #trip=<key>
    const key = new URLSearchParams(location.hash.slice(1)).get("trip");
    const trip = key && computeTrips().find((t) => t.key === key);
    if (trip) openTrip(trip);
  }
  start();
})();
