import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const fb = initializeApp({
  apiKey: "AIzaSyBHVjy83HBVJe_2gfR80fbPcJJ5i1rneW4",
  authDomain: "garmin-c59d7.firebaseapp.com",
  projectId: "garmin-c59d7",
  appId: "1:184080003125:web:764efe72df93a3b502417c"
});
const auth = getAuth(fb), db = getFirestore(fb);
const $ = (id) => document.getElementById(id);

// Activity record: { id, n: name, t: type, s: start (ISO, local time), d: metres, u: seconds, p: encoded polyline }
const CHUNK = 700000;            // characters per Firestore document (limit is 1 MiB)
const TYPES = {
  walk: ["הליכה", "#22c55e"], run: ["ריצה", "#f97316"], ride: ["רכיבה", "#3b82f6"],
  hike: ["טיול רגלי", "#a3e635"], swim: ["שחייה", "#06b6d4"], ski: ["סקי", "#f8fafc"],
  sup: ["סאפ", "#14b8a6"], other: ["אחר", "#e879f9"]
};
function kind(t) {
  t = (t || "").toLowerCase();
  if (/hik|mountaineer|trek/.test(t)) return "hike";
  if (/walk/.test(t)) return "walk";
  if (/run|jog/.test(t)) return "run";
  if (/cycl|bik|ride/.test(t)) return "ride";
  if (/swim/.test(t)) return "swim";
  if (/ski|snowboard/.test(t)) return "ski";
  if (/paddle/.test(t)) return "sup";
  return "other";
}

let acts = [], layers = new Map(), map, canvas, tiles, selected = null;
const off = new Set();

function msg(text, ms = 4000) {
  $("msg").textContent = text; $("msg").hidden = !text;
  clearTimeout(msg.t); if (text && ms) msg.t = setTimeout(() => ($("msg").hidden = true), ms);
}

// ---- polyline (Google encoded, precision 5) ----
function decode(str) {
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let r = 0, s = 0, b;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
      const dlt = r & 1 ? ~(r >> 1) : r >> 1;
      if (k === 0) lat += dlt; else lng += dlt;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
function encode(pts) {
  let out = "", pl = 0, pg = 0;
  const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; while (v >= 32) { out += String.fromCharCode((32 | (v & 31)) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
  for (const [a, b] of pts) { const la = Math.round(a * 1e5), lg = Math.round(b * 1e5); enc(la - pl); enc(lg - pg); pl = la; pg = lg; }
  return out;
}
// Douglas-Peucker, tolerance in degrees (~5 m)
function simplify(pts, tol = 0.00005) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let max = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---- storage ----
async function load() {
  const idx = await getDoc(doc(db, "meta", "index"));
  if (!idx.exists()) return [];
  const parts = await Promise.all(Array.from({ length: idx.data().chunks }, (_, i) => getDoc(doc(db, "chunks", String(i)))));
  return parts.flatMap((p) => JSON.parse(p.data().data));
}
async function save(list) {
  const chunks = []; let cur = [], size = 0;
  for (const a of list) {
    const len = JSON.stringify(a).length + 1;
    if (size + len > CHUNK && cur.length) { chunks.push(cur); cur = []; size = 0; }
    cur.push(a); size += len;
  }
  if (cur.length) chunks.push(cur);
  const old = await getDoc(doc(db, "meta", "index"));
  for (let i = 0; i < chunks.length; i++) {
    msg(`שומר… ${i + 1}/${chunks.length}`, 0);
    await setDoc(doc(db, "chunks", String(i)), { data: JSON.stringify(chunks[i]) });
  }
  await setDoc(doc(db, "meta", "index"), { chunks: chunks.length, count: list.length, updated: Date.now() });
  for (let i = chunks.length; old.exists() && i < old.data().chunks; i++) await deleteDoc(doc(db, "chunks", String(i)));
}

// ---- import ----
function parseGpx(text, fileName) {
  const x = new DOMParser().parseFromString(text, "application/xml");
  const pts = [...x.querySelectorAll("trkpt")].map((p) => [+p.getAttribute("lat"), +p.getAttribute("lon")]);
  if (pts.length < 2) return null;
  const times = [...x.querySelectorAll("trkpt > time")].map((t) => Date.parse(t.textContent));
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += map.distance(pts[i - 1], pts[i]);
  const start = times[0] || Date.parse(x.querySelector("metadata > time")?.textContent) || Date.now();
  const m = /activity_(\d+)/.exec(fileName);
  return {
    id: m ? +m[1] : "g" + start,
    n: x.querySelector("trk > name")?.textContent || fileName.replace(/\.gpx$/i, ""),
    t: x.querySelector("trk > type")?.textContent || "other",
    s: new Date(start - new Date(start).getTimezoneOffset() * 60000).toISOString().slice(0, 19),
    d: Math.round(d), u: times.length > 1 ? Math.round((times.at(-1) - times[0]) / 1000) : 0,
    p: encode(simplify(pts))
  };
}
async function importFiles(files) {
  const incoming = [];
  for (const f of files) {
    const text = await f.text();
    try {
      if (/\.gpx$/i.test(f.name)) { const a = parseGpx(text, f.name); if (a) incoming.push(a); }
      else incoming.push(...JSON.parse(text).filter((a) => a && a.id && a.p));
    } catch (e) { msg(`לא הצלחתי לקרוא את ${f.name}`); return; }
  }
  if (!incoming.length) { msg("לא נמצאו מסלולים בקבצים"); return; }
  const byId = new Map(acts.map((a) => [String(a.id), a]));
  const before = byId.size;
  for (const a of incoming) byId.set(String(a.id), a);
  const merged = [...byId.values()].sort((a, b) => (a.s < b.s ? 1 : -1));
  try { await save(merged); } catch (e) { msg("השמירה נכשלה: " + e.message, 0); return; }
  acts = merged; trailRes = null; build();
  if (!$("trails").hidden) { $("trails").hidden = true; toggleTrails(); }
  msg(`יובאו ${incoming.length} מסלולים (${merged.length - before} חדשים)`);
}

// ---- map ----
const km = (m) => (m / 1000).toFixed(m < 100000 ? 1 : 0);
const dur = (s) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
const date = (s) => s.slice(8, 10) + "/" + s.slice(5, 7) + "/" + s.slice(0, 4);

// A straight hop longer than this (metres) between two recorded points is a GPS glitch or a paused watch
// that was resumed elsewhere, not a real part of the workout; the line is cut there.
const JUMP = { walk: 1500, run: 1500, hike: 1500, swim: 1500, sup: 1500, ride: 4000, ski: 4000, other: 10000 };
function parts(pts, limit) {
  if (!$("clean").checked) return [pts];
  const out = []; let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (map.distance(pts[i - 1], pts[i]) > limit) { if (cur.length > 1) out.push(cur); cur = []; }
    cur.push(pts[i]);
  }
  if (cur.length > 1) out.push(cur);
  return out.length ? out : [pts];
}

// Viewer preferences (kept in this browser only)
const prefs = (() => { try { return JSON.parse(localStorage.getItem("garminMapPrefs")) || {}; } catch (e) { return {}; } })();
function savePrefs() { try { localStorage.setItem("garminMapPrefs", JSON.stringify(prefs)); } catch (e) { /* private mode */ } }
const strength = () => +$("strength").value / 100;
const base = (a) => ({ color: TYPES[kind(a.t)][1], weight: 1 + 2 * strength(), opacity: strength() });
function restyle() { for (const [a, line] of layers) if (a !== selected) line.setStyle(base(a)); }

function build() {
  for (const l of layers.values()) l.remove();
  layers.clear();
  for (const a of acts) {
    const line = L.polyline(parts(decode(a.p), JUMP[kind(a.t)]), { ...base(a), renderer: canvas });
    line.on("click", () => select(a, false));
    layers.set(a, line);
  }
  const years = [...new Set(acts.map((a) => a.s.slice(0, 4)))].sort().reverse();
  const cur = $("year").value;
  $("year").innerHTML = '<option value="">כל השנים</option>' + years.map((y) => `<option>${y}</option>`).join("");
  $("year").value = years.includes(cur) ? cur : "";
  const used = Object.keys(TYPES).filter((k) => acts.some((a) => kind(a.t) === k));
  $("types").innerHTML = "";
  const sum = () => {
    const on = used.filter((k) => !off.has(k));
    $("typesSum").textContent = on.length === used.length ? "כל סוגי האימון" : on.length === 1 ? TYPES[on[0]][0] : `${on.length} מתוך ${used.length} סוגים`;
  };
  for (const k of used) {
    const row = document.createElement("label");
    row.className = "trow";
    row.innerHTML = `<input type="checkbox"${off.has(k) ? "" : " checked"}><i style="background:${TYPES[k][1]}"></i>${TYPES[k][0]}`;
    row.firstChild.onchange = (e) => { e.target.checked ? off.delete(k) : off.add(k); sum(); apply(false); };
    $("types").appendChild(row);
  }
  sum();
  apply(false);
  // Tracks span several countries, so open on the area where most workouts start instead of fitting the whole world.
  if (acts.length) {
    const starts = [...layers.values()].map((l) => l.getLatLngs()[0][0]);
    const mid = (k) => starts.map((p) => p[k]).sort((a, b) => a - b)[starts.length >> 1];
    map.setView([mid("lat"), mid("lng")], 12);
  }
}

function apply(fit) {
  const y = $("year").value, shown = [];
  const only = trailRes && !$("trails").hidden ? trailRes[trailSel].mine : null;
  for (const [a, line] of layers) {
    const ok = (!y || a.s.startsWith(y)) && !off.has(kind(a.t)) && (!only || only.has(a));
    if (ok) { line.addTo(map); shown.push(a); } else line.remove();
  }
  $("stats").textContent = shown.length
    ? `${shown.length} אימונים · ${km(shown.reduce((s, a) => s + (a.d || 0), 0))} ק"מ`
    : acts.length ? "אין אימונים בסינון הזה" : "אין עדיין מסלולים — לחצו על ייבוא";
  $("list").innerHTML = "";
  for (const a of shown) {
    const el = document.createElement("div");
    el.className = "item"; el.dataset.id = a.id;
    el.innerHTML = `<i style="background:${TYPES[kind(a.t)][1]}"></i>${esc(a.n)}<small>${date(a.s)} · ${km(a.d || 0)} ק"מ · ${dur(a.u || 0)}</small>`;
    el.onclick = () => select(a, true);
    $("list").appendChild(el);
  }
  if (fit && shown.length) map.fitBounds(L.featureGroup(shown.map((a) => layers.get(a))).getBounds(), { padding: [20, 20] });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function select(a, zoom) {
  if (selected && layers.get(selected)) layers.get(selected).setStyle(base(selected));
  selected = a;
  const line = layers.get(a);
  line.setStyle({ weight: 5, opacity: 1, color: "#facc15" }).bringToFront();
  if (zoom) map.fitBounds(line.getBounds(), { padding: [40, 40] });
  const link = typeof a.id === "number" ? `<br><a href="https://connect.garmin.com/app/activity/${a.id}" target="_blank" rel="noopener">פתיחה ב-Garmin</a>` : "";
  L.popup().setLatLng(line.getBounds().getCenter())
    .setContent(`<b>${esc(a.n)}</b><br>${TYPES[kind(a.t)][0]} · ${date(a.s)} ${a.s.slice(11, 16)}<br>${km(a.d || 0)} ק"מ · ${dur(a.u || 0)}${link}`).openOn(map);
  for (const el of $("list").children) el.classList.toggle("sel", el.dataset.id === String(a.id));
}

// ---- trails: how much of each long-distance trail the workouts cover ----
// trails.json holds only public OpenStreetMap geometry; the coverage is computed here, in the browser,
// from the signed-in user's tracks, so nothing personal is published.
const STEP = 20;                 // metres between trail sample points
const CELL = 0.002;              // grid cell in degrees (~220 m), must exceed the largest tolerance
const RAD = Math.PI / 180;
const dist = (a, b) => {
  const x = (b[1] - a[1]) * RAD * Math.cos((a[0] + b[0]) / 2 * RAD), y = (b[0] - a[0]) * RAD;
  return Math.sqrt(x * x + y * y) * 6371000;
};
const cellKey = (la, lo) => Math.floor(la / CELL) + ":" + Math.floor(lo / CELL);
// Fastest plausible average (km/h) for a workout done on foot; anything quicker was recorded in a vehicle
// (e.g. a drive saved as "other" or as a hike) and must not count as walking a trail.
const FOOT_MAX = { walk: 9, hike: 9, other: 8, run: 20 };
const onFoot = (a) => {
  const k = kind(a.t);
  // "Travel" is the name the watch gives to trips recorded while driving, whatever their average speed
  if (!(k in FOOT_MAX) || /driv|motor/i.test(a.t || "") || /travel/i.test(a.n || "")) return false;
  return !(a.u > 0) || (a.d || 0) / a.u * 3.6 <= FOOT_MAX[k];
};
let trailData = null, trailRes = null, trailLayer = null, trailSel = 0;

function coverage(data) {
  // 1. sample every trail to points STEP apart; m = metres from the northern end
  const sampled = data.trails.map((t) => {
    const P = []; let m = 0;
    t.pieces.forEach((pc, piece) => {
      const pl = decode(pc.p);
      P.push({ p: pl[0], m, piece, tol: pc.tol });
      for (let i = 1; i < pl.length; i++) {
        const a = pl[i - 1], b = pl[i], d = dist(a, b), n = Math.max(1, Math.round(d / STEP));
        for (let k = 1; k <= n; k++) P.push({ p: [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], m: m + d * k / n, piece, tol: pc.tol });
        m += d;
      }
    });
    return P;
  });
  // 2. grid of the foot-track points, kept only in cells next to a trail
  const wanted = new Set();
  for (const P of sampled) for (const x of P) {
    const ci = Math.floor(x.p[0] / CELL), cj = Math.floor(x.p[1] / CELL);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) wanted.add(i + ":" + j);
  }
  const grid = new Map();
  const add = (la, lo, ai) => { const k = cellKey(la, lo); if (!wanted.has(k)) return; let c = grid.get(k); if (!c) grid.set(k, c = []); c.push(la, lo, ai); };
  acts.forEach((a, ai) => {
    if (!onFoot(a)) return;
    const pl = decode(a.p);
    add(pl[0][0], pl[0][1], ai);
    for (let i = 1; i < pl.length; i++) {
      const A = pl[i - 1], B = pl[i], d = dist(A, B);
      if (d > 3000) { add(B[0], B[1], ai); continue; }   // GPS jump
      const n = Math.max(1, Math.ceil(d / 15));
      for (let k = 1; k <= n; k++) add(A[0] + (B[0] - A[0]) * k / n, A[1] + (B[1] - A[1]) * k / n, ai);
    }
  });
  const near = (x) => {
    const hit = new Set(), ci = Math.floor(x.p[0] / CELL), cj = Math.floor(x.p[1] / CELL);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      const c = grid.get(i + ":" + j); if (!c) continue;
      for (let k = 0; k < c.length; k += 3) if (!hit.has(c[k + 2]) && dist(x.p, [c[k], c[k + 1]]) <= x.tol) hit.add(c[k + 2]);
    }
    return hit;
  };
  const placeOf = (p) => {
    let best = "", bd = Infinity;
    for (const q of data.places) { if (Math.abs(q[0] - p[0]) > 0.1) continue; const d = dist(p, q); if (d < bd) { bd = d; best = q[2]; } }
    return best;
  };
  // 3. per trail: covered points -> stretches, 10-km sections and map lines
  return data.trails.map((t, ti) => {
    const P = sampled[ti], n = P.length, hits = P.map(near), cov = hits.map((h) => h.size > 0);
    const runs = (val) => {
      const r = []; let s = -1;
      for (let i = 0; i <= n; i++) {
        const same = i < n && cov[i] === val;
        if (s >= 0 && (!same || P[i].piece !== P[i - 1].piece)) { r.push([s, i - 1]); s = -1; }
        if (same && s < 0) s = i;
      }
      return r;
    };
    // a hole of up to 120 m inside a walked stretch is GPS noise; a stretch under 300 m is just a crossing
    for (const [a, b] of runs(false)) if (a > 0 && b < n - 1 && P[a - 1].piece === P[b + 1].piece && P[b].m - P[a].m <= 120) for (let i = a; i <= b; i++) cov[i] = true;
    for (const [a, b] of runs(true)) if (P[b].m - P[a].m < 300) for (let i = a; i <= b; i++) cov[i] = false;
    const total = P[n - 1].m; let done = 0;
    const mine = new Set();      // workouts that walked at least 200 m of this trail
    const stretches = runs(true).map(([a, b]) => {
      done += P[b].m - P[a].m;
      const cnt = new Map();
      for (let i = a; i <= b; i++) for (const ai of hits[i]) cnt.set(ai, (cnt.get(ai) || 0) + 1);
      for (const [ai, c] of cnt) if (c * STEP >= 200) mine.add(acts[ai]);
      return {
        from: P[a].m, to: P[b].m, a: placeOf(P[a].p), b: placeOf(P[b].p),
        bounds: L.latLngBounds(P.slice(a, b + 1).map((x) => x.p)),
        acts: [...cnt].filter((e) => e[1] * STEP >= 200).sort((x, y) => y[1] - x[1]).slice(0, 5).map((e) => acts[e[0]])
      };
    });
    const sec = [];
    for (let i = 0, s = 0; i < n; s += 10000) {
      const first = i; let dn = 0;
      for (; i < n && P[i].m < s + 10000; i++) if (cov[i]) dn++;
      if (i > first) sec.push({ from: s, to: Math.min(s + 10000, total), pct: Math.round(dn / (i - first) * 100), a: placeOf(P[first].p), b: placeOf(P[i - 1].p) });
    }
    const lines = { done: [], miss: [] }; let cur = null;
    for (let i = 0; i < n; i++) {
      const brk = i > 0 && P[i].piece !== P[i - 1].piece;
      if (!cur || brk || cov[i] !== cov[i - 1]) {
        if (cur && !brk) cur.push(P[i].p);              // close the visual gap between the two colours
        cur = [P[i].p]; (cov[i] ? lines.done : lines.miss).push(cur);
      } else if (i % 2 === 0 || i === n - 1 || (i + 1 < n && (cov[i + 1] !== cov[i] || P[i + 1].piece !== P[i].piece))) cur.push(P[i].p);
    }
    return { name: t.name, note: t.note || "", total, done, stretches, sec, lines, mine };
  });
}

function drawTrail() {
  if (trailLayer) { trailLayer.remove(); trailLayer = null; }
  apply(false);                  // while a trail is shown, only the workouts that walked it stay on the map
  if ($("trails").hidden || !trailRes) return;
  const t = trailRes[trailSel];
  const opt = { pane: "trails", renderer: drawTrail.svg, interactive: false };
  trailLayer = L.featureGroup([
    L.polyline(t.lines.miss, { ...opt, color: "#ef4444", weight: 3, opacity: 0.85 }),
    L.polyline(t.lines.done, { ...opt, color: "#22c55e", weight: 6, opacity: 0.95 })
  ]).addTo(map);
  const pct = (t.done / t.total * 100).toFixed(1);
  const span = (s) => esc(s.a) + (s.b && s.b !== s.a ? " ← " + esc(s.b) : "");
  const k1 = (m) => (m / 1000).toFixed(1);
  $("trails").innerHTML =
    `<div class="ttabs">${trailRes.map((r, i) => `<button data-i="${i}" class="${i === trailSel ? "on" : ""}">${esc(r.name)}<small>${(r.done / r.total * 100).toFixed(0)}%</small></button>`).join("")}</div>
     <div class="tsum"><b>${pct}%</b> ${t.note ? `<small>${esc(t.note)}</small>` : ""}
       <div>${k1(t.done)} ק"מ מתוך ${k1(t.total)} · נשארו ${k1(t.total - t.done)} ק"מ</div>
       <div class="tbar"><i style="width:${pct}%"></i></div></div>
     <h3>הקטעים שעשיתי (${t.stretches.length})</h3>
     ${t.stretches.map((s, i) => `<div class="item tst" data-i="${i}"><span class="tkm">${k1(s.from)}–${k1(s.to)}</span> ${span(s)} · ${k1(s.to - s.from)} ק"מ
        <small>${s.acts.map((a) => date(a.s) + " " + esc(a.n)).join(" · ")}</small></div>`).join("")}
     <h3>לפי מקטעים של 10 ק"מ</h3>
     ${t.sec.map((s) => `<div class="tsec"><span class="tkm">${Math.round(s.from / 1000)}–${Math.round(s.to / 1000)}</span><span class="tname">${span(s)}</span><span class="tmini"><i style="width:${s.pct}%"></i></span><span class="tkm">${s.pct}%</span></div>`).join("")}
     <p class="tfoot">נספרים אימוני הליכה, ריצה וטיול במרחק עד 50 מ' מהשביל (200 מ' מקו החוף היכן ששביל הים אינו מסומן). תוואי השבילים: OpenStreetMap.</p>`;
  for (const b of $("trails").querySelectorAll(".ttabs button")) b.onclick = () => { trailSel = +b.dataset.i; drawTrail(); map.fitBounds(trailLayer.getBounds(), { padding: [20, 20] }); };
  for (const el of $("trails").querySelectorAll(".tst")) el.onclick = () => map.fitBounds(t.stretches[+el.dataset.i].bounds, { padding: [60, 60], maxZoom: 15 });
}

async function toggleTrails() {
  const show = $("trails").hidden;
  $("trails").hidden = !show; $("btnTrails").classList.toggle("active", show);
  if (show) $("list").hidden = true;
  map.invalidateSize();
  if (!show) { drawTrail(); return; }
  try {
    if (!trailData) { msg("טוען שבילים…", 0); trailData = await (await fetch("trails.json?v=1")).json(); }
    if (!trailRes) {
      msg("מחשב כיסוי…", 0);
      await new Promise((r) => setTimeout(r, 30));      // let the message paint before the heavy loop
      trailRes = coverage(trailData);
    }
    msg("");
  } catch (e) { msg("טעינת השבילים נכשלה: " + e.message, 0); return; }
  if (!drawTrail.svg) { map.createPane("trails").style.zIndex = 450; drawTrail.svg = L.svg({ pane: "trails" }); }
  drawTrail();
  map.fitBounds(trailLayer.getBounds(), { padding: [20, 20] });
}

// ---- wiring ----
$("btnLogin").onclick = async () => {
  $("loginErr").textContent = "";
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(e.code)) await signInWithRedirect(auth, new GoogleAuthProvider());
    else $("loginErr").textContent = e.message;
  }
};
$("btnOut").onclick = () => signOut(auth);
$("btnImport").onclick = () => $("file").click();
$("file").onchange = (e) => { importFiles([...e.target.files]); e.target.value = ""; };
$("btnList").onclick = () => {
  if (!$("trails").hidden) toggleTrails();
  $("list").hidden = !$("list").hidden; map.invalidateSize();
};
$("btnTrails").onclick = toggleTrails;
// The filter bar scrolls sideways, which would clip a normal dropdown, so the type menu is placed with fixed coordinates.
$("typesBox").ontoggle = () => {
  if (!$("typesBox").open) return;
  const r = $("typesSum").getBoundingClientRect(), m = $("types");
  m.style.top = r.bottom + 4 + "px";
  m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + "px";
};
document.addEventListener("click", (e) => { if (!$("typesBox").contains(e.target)) $("typesBox").open = false; });
$("filters").addEventListener("scroll", () => { $("typesBox").open = false; });
$("year").onchange = () => apply(true);
$("strength").value = prefs.strength ?? 75;
$("bright").value = prefs.bright ?? 100;
$("clean").checked = prefs.clean ?? true;
$("strength").oninput = () => { prefs.strength = +$("strength").value; savePrefs(); restyle(); };
$("bright").oninput = () => { prefs.bright = +$("bright").value; savePrefs(); if (tiles) tiles.setOpacity(prefs.bright / 100); };
$("clean").onchange = () => {
  prefs.clean = $("clean").checked; savePrefs();
  for (const [a, line] of layers) line.setLatLngs(parts(decode(a.p), JUMP[kind(a.t)]));
};

onAuthStateChanged(auth, async (u) => {
  for (const id of ["btnOut", "btnImport", "btnList", "btnTrails"]) $(id).hidden = !u;
  $("login").hidden = !!u; $("app").hidden = !u;
  if (!u) return;
  if (!map) {
    map = L.map("map", { preferCanvas: true }).setView([32.27, 34.89], 12);
    canvas = L.canvas({ tolerance: 6 });
    tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap", opacity: $("bright").value / 100 }).addTo(map);
  }
  try { acts = await load(); trailRes = null; build(); }
  catch (e) {
    $("stats").textContent = "";
    msg(e.code === "permission-denied" ? "לחשבון הזה אין הרשאה לצפות במסלולים" : "טעינת המסלולים נכשלה: " + e.message, 0);
  }
});
