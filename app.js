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

let acts = [], layers = new Map(), map, canvas, selected = null;
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
  acts = merged; build();
  msg(`יובאו ${incoming.length} מסלולים (${merged.length - before} חדשים)`);
}

// ---- map ----
const km = (m) => (m / 1000).toFixed(m < 100000 ? 1 : 0);
const dur = (s) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
const date = (s) => s.slice(8, 10) + "/" + s.slice(5, 7) + "/" + s.slice(0, 4);

function build() {
  for (const l of layers.values()) l.remove();
  layers.clear();
  for (const a of acts) {
    const k = kind(a.t);
    const line = L.polyline(decode(a.p), { color: TYPES[k][1], weight: 2.5, opacity: 0.75, renderer: canvas });
    line.on("click", () => select(a, false));
    layers.set(a, line);
  }
  const years = [...new Set(acts.map((a) => a.s.slice(0, 4)))].sort().reverse();
  const cur = $("year").value;
  $("year").innerHTML = '<option value="">כל השנים</option>' + years.map((y) => `<option>${y}</option>`).join("");
  $("year").value = years.includes(cur) ? cur : "";
  const used = Object.keys(TYPES).filter((k) => acts.some((a) => kind(a.t) === k));
  $("types").innerHTML = "";
  for (const k of used) {
    const b = document.createElement("button");
    b.className = "chip" + (off.has(k) ? "" : " on");
    b.innerHTML = `<i style="background:${TYPES[k][1]}"></i>${TYPES[k][0]}`;
    b.onclick = () => { off.has(k) ? off.delete(k) : off.add(k); b.classList.toggle("on"); apply(false); };
    $("types").appendChild(b);
  }
  apply(true);
}

function apply(fit) {
  const y = $("year").value, shown = [];
  for (const [a, line] of layers) {
    const ok = (!y || a.s.startsWith(y)) && !off.has(kind(a.t));
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
  if (selected && layers.get(selected)) layers.get(selected).setStyle({ weight: 2.5, opacity: 0.75, color: TYPES[kind(selected.t)][1] });
  selected = a;
  const line = layers.get(a);
  line.setStyle({ weight: 5, opacity: 1, color: "#facc15" }).bringToFront();
  if (zoom) map.fitBounds(line.getBounds(), { padding: [40, 40] });
  const link = typeof a.id === "number" ? `<br><a href="https://connect.garmin.com/app/activity/${a.id}" target="_blank" rel="noopener">פתיחה ב-Garmin</a>` : "";
  L.popup().setLatLng(line.getBounds().getCenter())
    .setContent(`<b>${esc(a.n)}</b><br>${TYPES[kind(a.t)][0]} · ${date(a.s)} ${a.s.slice(11, 16)}<br>${km(a.d || 0)} ק"מ · ${dur(a.u || 0)}${link}`).openOn(map);
  for (const el of $("list").children) el.classList.toggle("sel", el.dataset.id === String(a.id));
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
$("btnList").onclick = () => { $("list").hidden = !$("list").hidden; map.invalidateSize(); };
$("year").onchange = () => apply(true);

onAuthStateChanged(auth, async (u) => {
  for (const id of ["btnOut", "btnImport", "btnList"]) $(id).hidden = !u;
  $("login").hidden = !!u; $("app").hidden = !u;
  if (!u) return;
  if (!map) {
    map = L.map("map", { preferCanvas: true }).setView([32.27, 34.89], 12);
    canvas = L.canvas({ tolerance: 6 });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
  }
  try { acts = await load(); build(); }
  catch (e) {
    $("stats").textContent = "";
    msg(e.code === "permission-denied" ? "לחשבון הזה אין הרשאה לצפות במסלולים" : "טעינת המסלולים נכשלה: " + e.message, 0);
  }
});
