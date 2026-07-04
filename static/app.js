"use strict";

/* RingTaxi Onboard — cockpit player logic (vanilla, offline).
 * Time source is the real <video> element. Telemetry/laps/track come from
 * the local API (server.py). No frameworks, no CDNs. */

/* ---- series colors (kept in sync with style.css) ---- */
const SERIES = { speed: "#199e70", alt: "#3987e5", glat: "#d95926", glon: "#9085e9", vertg: "#b8860b" };
const ACCENT = "#ff5f1f";
const GRID = "#22262b";
const AXIS_TEXT = "#5f6772";
const CHART_SURFACE = "#0d1013";

const state = {
  laps: [],
  telemetryCache: new Map(),   // lapNumber -> telemetry {t, speedKmh, lat, lon, alt, latG, lonG, vertG, heading}
  activeLapNumber: null,
  track: null,                 // {lines, curves}
  units: "kmh",                // 'kmh' | 'mph'
  mapStyle: "satellite",       // 'satellite' | 'schematic'
  hoverT: null,
  mapHover: null,
  lastSample: null,
  rafId: null,
  mapProj: null,
  mapDrawnFor: null,
  chartsBuiltFor: null,
};

/* ---- DOM ---- */
const $ = (id) => document.getElementById(id);
const video = $("player");
const pillsEl = $("lap-pills");
const hud = { speed: $("hud-speed"), unit: $("hud-speed-unit"), corner: $("hud-corner"), timecode: $("hud-timecode"), rec: $("rec-dot"), brake: $("hud-brake"), throttle: $("hud-throttle") };
const altValueEl = $("alt-value"), latgEl = $("latg-value"), longEl = $("long-value");
const mapCornerEl = $("map-corner");
const canvas = $("track-canvas"), ctx = canvas.getContext("2d");
const gballCanvas = $("gball-canvas"), gctx = gballCanvas.getContext("2d");

/* ---- formatting ---- */
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function fmtT(s) { s = Math.max(0, s || 0); const m = Math.floor(s / 60); const r = s - m * 60; return m + ":" + r.toFixed(1).padStart(4, "0"); }
function fmtLap(s) { const m = Math.floor(s / 60); const sec = Math.floor(s % 60); const ms = Math.round((s - m * 60 - sec) * 1000); return m + ":" + String(sec).padStart(2, "0") + "." + String(ms).padStart(3, "0"); }
function spConv(kmh) { return state.units === "mph" ? kmh * 0.621371 : kmh; }
function spUnit() { return state.units === "mph" ? "mph" : "km/h"; }
function signed(v, d) { const s = v.toFixed(d); return v >= 0 ? "+" + s : s; }

/* ================= laps / pills / kpis ================= */
function lapBadge(lap) { return lap.isFullLap ? "Full lap" : (lap.label === "In-lap" ? "In-lap" : "Out-lap"); }

function buildPills() {
  pillsEl.innerHTML = "";
  state.pillEls = [];
  for (const lap of state.laps) {
    const b = document.createElement("button");
    b.className = "pill";
    b.dataset.lapNumber = String(lap.lapNumber);
    b.innerHTML = "<span>L" + lap.lapNumber + " " + lapBadge(lap) + "</span>" +
      "<span class='pill-time'>" + fmtLap(lap.durationSeconds) + "</span>";
    b.addEventListener("click", () => { video.currentTime = lap.videoOffsetSeconds + (lap.isFullLap ? 0.05 : 0); video.play().catch(() => {}); setActiveLap(lap.lapNumber); });
    pillsEl.appendChild(b);
    state.pillEls.push(b);
  }
}
function highlightPill(lapNumber) {
  if (!state.pillEls) return;
  for (const b of state.pillEls) b.classList.toggle("is-active", Number(b.dataset.lapNumber) === lapNumber);
}

function refreshKpis() {
  const full = state.laps.find((l) => l.isFullLap);
  if (!full) return;
  const tel = state.telemetryCache.get(full.lapNumber);
  if (!tel) return;
  const top = Math.max.apply(null, tel.speedKmh);
  const maxLat = Math.max.apply(null, tel.latG.map(Math.abs));
  $("kpi-top").textContent = Math.round(spConv(top)) + " " + spUnit();
  $("kpi-maxg").textContent = maxLat.toFixed(2) + " g";
}
function refreshSessionDate() {
  const l = state.laps[0]; if (!l) return;
  const raw = l.startTime || l.start || l.startTimeLocal || l.startWallClock;
  if (!raw) return;
  const d = new Date(String(raw).replace(" ", "T"));
  if (isNaN(d.getTime())) { $("session-date").textContent = String(raw); return; }
  const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()];
  const p = (n) => String(n).padStart(2, "0");
  $("session-date").textContent = p(d.getDate()) + " " + mon + " " + d.getFullYear() + " · " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* ================= units / hud / map / rate toggles ================= */
const HUD_MODES = ["full", "min", "off"];
let hudModeIdx = 0;
$("hud-toggle").addEventListener("click", () => {
  hudModeIdx = (hudModeIdx + 1) % HUD_MODES.length;
  const m = HUD_MODES[hudModeIdx];
  $("hud").className = "hud hud--" + m;
  $("hud-toggle").textContent = "HUD: " + m[0].toUpperCase() + m.slice(1);
});

$("units-toggle").addEventListener("click", () => {
  state.units = state.units === "kmh" ? "mph" : "kmh";
  $("units-toggle").textContent = spUnit();
  $("chart-title-speed").textContent = "Speed (" + spUnit() + ")";
  refreshKpis();
  if (state.activeLapNumber != null) buildCharts(state.telemetryCache.get(state.activeLapNumber), state.laps.find((l) => l.lapNumber === state.activeLapNumber));
  updateDisplay();
});

function buildMapToggle() {
  const host = $("map-toggle"); host.innerHTML = "";
  [["satellite", "Sat"], ["schematic", "Map"]].forEach(([v, lbl]) => {
    const b = document.createElement("button");
    b.textContent = lbl; b.dataset.v = v;
    b.classList.toggle("is-active", state.mapStyle === v);
    b.addEventListener("click", () => {
      state.mapStyle = v;
      for (const c of host.children) c.classList.toggle("is-active", c.dataset.v === v);
      if (state.activeLapNumber != null) drawStaticTrack(state.telemetryCache.get(state.activeLapNumber));
      redrawTrack(state.lastSample);
    });
    host.appendChild(b);
  });
}

function buildRates() {
  const host = $("rates"); host.innerHTML = "";
  [0.5, 1, 2].forEach((r) => {
    const b = document.createElement("button");
    b.className = "rate-btn"; b.textContent = (r === 1 ? "1" : r) + "×"; b.dataset.r = String(r);
    b.classList.toggle("is-active", r === 1);
    b.addEventListener("click", () => { video.playbackRate = r; for (const c of host.children) c.classList.toggle("is-active", Number(c.dataset.r) === r); });
    host.appendChild(b);
  });
}

/* ================= telemetry ================= */
function setActiveLap(lapNumber) {
  if (state.activeLapNumber === lapNumber) return;
  state.activeLapNumber = lapNumber;
  highlightPill(lapNumber);
  ensureTelemetry(lapNumber);
}
function findLapForTime(t) {
  for (const lap of state.laps) {
    const start = lap.videoOffsetSeconds, end = start + lap.durationSeconds;
    if (t >= start - 0.05 && t < end + 0.05) return lap;
  }
  return null;
}
async function ensureTelemetry(lapNumber) {
  if (state.telemetryCache.has(lapNumber)) return state.telemetryCache.get(lapNumber);
  try {
    const res = await fetch("/api/telemetry/" + lapNumber);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    data.lapNumber = lapNumber;
    state.telemetryCache.set(lapNumber, data);
    if (state.activeLapNumber === lapNumber) {
      drawStaticTrack(data);
      buildCharts(data, state.laps.find((l) => l.lapNumber === lapNumber));
    }
    return data;
  } catch (err) { console.error("telemetry fetch failed", lapNumber, err); return null; }
}

function lerpAngle(a, b, f) { const diff = ((b - a + 540) % 360) - 180; return (a + diff * f + 360) % 360; }
function interpolate(tel, t) {
  const arr = tel.t; if (!arr || !arr.length) return null;
  if (t <= arr[0]) return sampleAt(tel, 0);
  if (t >= arr[arr.length - 1]) return sampleAt(tel, arr.length - 1);
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= t) lo = m; else hi = m; }
  const t0 = arr[lo], t1 = arr[hi], f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const L = (k) => tel[k][lo] + (tel[k][hi] - tel[k][lo]) * f;
  return { speedKmh: L("speedKmh"), lat: L("lat"), lon: L("lon"), alt: L("alt"), latG: L("latG"), lonG: L("lonG"), vertG: L("vertG"), heading: lerpAngle(tel.heading[lo], tel.heading[hi], f) };
}
function sampleAt(tel, i) { return { speedKmh: tel.speedKmh[i], lat: tel.lat[i], lon: tel.lon[i], alt: tel.alt[i], latG: tel.latG[i], lonG: tel.lonG[i], vertG: tel.vertG[i], heading: tel.heading[i] }; }

/* ================= map / GPS track ================= */
const MAP_PAD = 34;
function projectPoints(tel) {
  const lats = tel.lat, lons = tel.lon; if (!lats.length) return null;
  const avgLat = lats.reduce((a, b) => a + b, 0) / lats.length;
  const cosLat = Math.cos(avgLat * Math.PI / 180);
  const xs = lons.map((l) => l * cosLat), ys = lats.map((l) => -l);
  const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  return { cosLat, minX, minY, spanX: Math.max(maxX - minX, 1e-9), spanY: Math.max(maxY - minY, 1e-9) };
}
function toXY(pr, lat, lon, W, H, pad) {
  const x = lon * pr.cosLat, y = -lat, uw = W - pad * 2, uh = H - pad * 2;
  const s = Math.min(uw / pr.spanX, uh / pr.spanY);
  const ox = pad + (uw - pr.spanX * s) / 2, oy = pad + (uh - pr.spanY * s) / 2;
  return { x: ox + (x - pr.minX) * s, y: oy + (y - pr.minY) * s };
}
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function drawStaticTrack(tel) {
  if (!tel || !state.cssW) return;
  const W = state.cssW, H = state.cssH, dpr = state.dpr;
  const pr = projectPoints(tel); state.mapProj = pr; state.mapDrawnFor = tel.lapNumber;
  const off = document.createElement("canvas"); off.width = canvas.width; off.height = canvas.height;
  const c = off.getContext("2d"); c.scale(dpr, dpr);
  const pts = tel.lat.map((_, i) => toXY(pr, tel.lat[i], tel.lon[i], W, H, MAP_PAD));

  if (state.mapStyle === "satellite") {
    c.fillStyle = "#141c16"; c.fillRect(0, 0, W, H);
    const rnd = mulberry32(91);
    for (let k = 0; k < 120; k++) { const x = rnd() * W, y = rnd() * H, r = 8 + rnd() * 46, g = Math.floor(30 + rnd() * 36); c.fillStyle = "rgba(" + (g - 8) + "," + (g + 14) + "," + (g - 6) + ",.5)"; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }
    for (let k = 0; k < 200; k++) { const x = rnd() * W, y = rnd() * H; c.fillStyle = "rgba(18,32,20,.6)"; c.beginPath(); c.arc(x, y, 1.4 + rnd() * 2.2, 0, 7); c.fill(); }
    c.strokeStyle = "rgba(120,120,112,.28)"; c.lineWidth = 3; c.beginPath(); c.moveTo(0, H * 0.72); c.bezierCurveTo(W * 0.3, H * 0.5, W * 0.6, H * 0.9, W, H * 0.62); c.stroke();
    c.lineWidth = 2; c.beginPath(); c.moveTo(W * 0.15, 0); c.bezierCurveTo(W * 0.35, H * 0.4, W * 0.1, H * 0.7, W * 0.4, H); c.stroke();
    c.fillStyle = "rgba(0,0,0,.16)"; c.fillRect(0, 0, W, H);
    const corridor = 12; c.lineJoin = "round"; c.lineCap = "round";
    c.strokeStyle = "#0c0e0d"; c.lineWidth = corridor + 4; strokePath(c, pts);
    c.strokeStyle = "#43474d"; c.lineWidth = corridor; strokePath(c, pts);
    c.strokeStyle = "#5a5f66"; c.lineWidth = corridor * 0.5; strokePath(c, pts);
    c.strokeStyle = "#8fffb0"; c.globalAlpha = 0.9; c.lineWidth = 2; strokePath(c, pts); c.globalAlpha = 1;
  } else {
    c.fillStyle = "#0d1013"; c.fillRect(0, 0, W, H);
    c.strokeStyle = "#1a1f25"; c.lineWidth = 1;
    for (let gx = 0; gx < W; gx += 40) { c.beginPath(); c.moveTo(gx + 0.5, 0); c.lineTo(gx + 0.5, H); c.stroke(); }
    for (let gy = 0; gy < H; gy += 40) { c.beginPath(); c.moveTo(0, gy + 0.5); c.lineTo(W, gy + 0.5); c.stroke(); }
    c.lineJoin = "round"; c.lineCap = "round"; c.strokeStyle = "#8fffb0"; c.globalAlpha = 0.85; c.lineWidth = 2.5; strokePath(c, pts); c.globalAlpha = 1;
  }
  drawTrackLines(c, pr, W, H);
  state.mapStatic = off;
}
function strokePath(c, pts) { c.beginPath(); pts.forEach((p, i) => { i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y); }); c.stroke(); }

function drawTrackLines(c, pr, W, H) {
  if (!state.track) return;
  for (const line of state.track.lines) {
    const pts = line.points.map((p) => toXY(pr, p.lat, p.lon, W, H, MAP_PAD));
    if (pts.length < 2) continue;
    const isSector = line.kind === "sector";
    c.strokeStyle = isSector ? "#7f8994" : ACCENT; c.globalAlpha = isSector ? 0.6 : 0.95; c.lineWidth = isSector ? 1.8 : 2.5;
    strokePath(c, pts); c.globalAlpha = 1;
    const mid = pts[Math.floor(pts.length / 2)];
    c.fillStyle = isSector ? AXIS_TEXT : ACCENT; c.font = "700 10px ui-monospace, monospace"; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(line.label, mid.x, mid.y - 9);
  }
}

function drawHeadingArrow(c, x, y, headingDeg) {
  c.save(); c.translate(x, y); c.rotate(headingDeg * Math.PI / 180);
  c.fillStyle = ACCENT; c.shadowColor = ACCENT; c.shadowBlur = 12;
  c.beginPath(); c.moveTo(0, -8); c.lineTo(5.5, 6); c.lineTo(-5.5, 6); c.closePath(); c.fill(); c.shadowBlur = 0; c.restore();
}

function redrawTrack(dot) {
  if (!state.mapStatic) return;
  const W = state.cssW, H = state.cssH, dpr = state.dpr, pr = state.mapProj;
  state.lastSample = dot;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(state.mapStatic, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state.mapHover) { ctx.strokeStyle = "#e8ebee"; ctx.globalAlpha = 0.6; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(state.mapHover.x, state.mapHover.y, 7, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }
  if (dot) { const p = toXY(pr, dot.lat, dot.lon, W, H, MAP_PAD); drawHeadingArrow(ctx, p.x, p.y, dot.heading != null ? dot.heading : 0); }
}

/* click / drag to seek on the map */
function mapXY(ev) { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
function nearestPoint(x, y) {
  const tel = state.telemetryCache.get(state.mapDrawnFor); if (!tel || !state.mapProj) return null;
  let bi = -1, bd = 26 * 26;
  for (let i = 0; i < tel.lat.length; i++) { const p = toXY(state.mapProj, tel.lat[i], tel.lon[i], state.cssW, state.cssH, MAP_PAD); const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; bi = i; } }
  if (bi < 0) return null;
  const p = toXY(state.mapProj, tel.lat[bi], tel.lon[bi], state.cssW, state.cssH, MAP_PAD);
  return { t: tel.t[bi], x: p.x, y: p.y };
}
let mapDrag = false;
function mapSeek(ev) { const { x, y } = mapXY(ev); const h = nearestPoint(x, y); if (h) { video.currentTime = h.t; state.mapHover = { x: h.x, y: h.y }; } return h; }
canvas.addEventListener("pointerdown", (ev) => { if (ev.button) return; if (mapSeek(ev)) { mapDrag = true; canvas.setPointerCapture(ev.pointerId); } });
canvas.addEventListener("pointermove", (ev) => { if (mapDrag) { mapSeek(ev); return; } const { x, y } = mapXY(ev); const h = nearestPoint(x, y); state.mapHover = h ? { x: h.x, y: h.y } : null; if (video.paused) redrawTrack(state.lastSample); });
function endMapDrag(ev) { mapDrag = false; if (ev.type === "pointerleave") { state.mapHover = null; if (video.paused) redrawTrack(state.lastSample); } }
canvas.addEventListener("pointerup", endMapDrag); canvas.addEventListener("pointercancel", endMapDrag); canvas.addEventListener("pointerleave", endMapDrag);

/* ================= G-ball ================= */
function drawGBall(latG, lonG) {
  const dpr = state.dpr || 1, W = 116, H = 116; gctx.setTransform(dpr, 0, 0, dpr, 0, 0); gctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, rMax = W / 2 - 11, MAXG = 2, scale = rMax / MAXG;
  gctx.strokeStyle = GRID; gctx.lineWidth = 1; gctx.beginPath(); gctx.moveTo(cx - rMax, cy); gctx.lineTo(cx + rMax, cy); gctx.moveTo(cx, cy - rMax); gctx.lineTo(cx, cy + rMax); gctx.stroke();
  for (const g of [0.5, 1, 1.5]) { gctx.strokeStyle = g === 1 ? "#343a42" : GRID; gctx.beginPath(); gctx.arc(cx, cy, g * scale, 0, 7); gctx.stroke(); }
  gctx.fillStyle = AXIS_TEXT; gctx.font = "9px ui-monospace, monospace"; gctx.textAlign = "left"; gctx.textBaseline = "bottom";
  for (const g of [1, 1.5]) gctx.fillText(g.toFixed(1), cx + 3, cy - g * scale - 1);
  if (latG == null) return;
  const gx = clamp(latG, -MAXG, MAXG), gy = clamp(lonG, -MAXG, MAXG), px = cx + gx * scale, py = cy - gy * scale;
  gctx.beginPath(); gctx.arc(px, py, 7, 0, 7); gctx.fillStyle = "#131619"; gctx.fill();
  gctx.beginPath(); gctx.arc(px, py, 5, 0, 7); gctx.fillStyle = ACCENT; gctx.fill();
}

/* ================= charts ================= */
function niceStep(range) { const t = range / 4; for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200]) if (s >= t) return s; return 500; }
function smoothArr(a, w) { const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = -w; j <= w; j++) { const k = i + j; if (k < 0 || k >= n) continue; s += a[k]; c++; } o[i] = s / c; } return o; }
function chartDefs() {
  const F = state.units === "mph" ? 0.621371 : 1;
  return [
    { id: "chart-speed", conv: (v) => v * F, series: [{ field: "speedKmh", color: SERIES.speed, valueId: "chart-value-speed", fmt: (v) => String(Math.round(v * F)) }],
      domain: (tel) => { const mx = Math.max.apply(null, tel.speedKmh.map((v) => v * F)); const st = state.units === "mph" ? 25 : 50; return [0, Math.max(st, Math.ceil(mx / st) * st)]; }, step: state.units === "mph" ? 25 : 50, timeAxis: false },
    { id: "chart-alt", conv: (v) => v, series: [{ field: "alt", color: SERIES.alt, valueId: "chart-value-alt", fmt: (v) => v.toFixed(0) }],
      domain: (tel) => { const mn = Math.min.apply(null, tel.alt), mx = Math.max.apply(null, tel.alt), st = niceStep(mx - mn); return [Math.floor(mn / st) * st, Math.ceil(mx / st) * st]; }, step: null, timeAxis: false },
    { id: "chart-g", conv: (v) => v, series: [
        { field: "latG", color: SERIES.glat, valueId: "chart-value-glat", fmt: (v) => signed(v, 2) },
        { field: "lonG", color: SERIES.glon, valueId: "chart-value-glon", fmt: (v) => signed(v, 2) },
        { field: "vertG", color: SERIES.vertg, valueId: "chart-value-vertg", fmt: (v) => signed(v, 2) } ],
      domain: () => [-2, 2], step: 1, timeAxis: true, zero: true, lineWidth: 1.3, smoothWin: 3 },
  ];
}
const charts = [];
for (const id of ["chart-speed", "chart-alt", "chart-g"]) {
  const root = $(id), cv = root.querySelector(".chart-canvas");
  charts.push({ id, root, cv, ctx2d: cv.getContext("2d"), def: null, stat: null, geom: null });
}
const CHART_MARGIN = { left: 42, right: 10, top: 8 };

function buildCharts(tel, lap) {
  if (!tel || !state.dpr) return;
  const defs = chartDefs();
  charts.forEach((c, i) => { c.def = defs[i]; });
  state.chartsBuiltFor = tel.lapNumber;
  const tArr = tel.t; if (!tArr || tArr.length < 2) return;
  const t0 = tArr[0], t1 = tArr[tArr.length - 1];
  const sectorTs = [];
  if (lap && lap.isFullLap && lap.sectors) for (const sec of lap.sectors) { const st = sec.offsetSeconds; if (st > t0 + 1 && st < t1 - 1) sectorTs.push(st); }
  const dpr = state.dpr;
  for (const chart of charts) {
    const def = chart.def, W = chart.cv.clientWidth, H = chart.cv.clientHeight; if (!W || !H) continue;
    chart.cv.width = Math.round(W * dpr); chart.cv.height = Math.round(H * dpr);
    const bottom = def.timeAxis ? 18 : 8;
    const plot = { x: CHART_MARGIN.left, y: CHART_MARGIN.top, w: W - CHART_MARGIN.left - CHART_MARGIN.right, h: H - CHART_MARGIN.top - bottom };
    const [y0, y1] = def.domain(tel);
    chart.geom = { dpr, W, H, plot, t0, t1, y0, y1,
      tToX: (t) => plot.x + ((t - t0) / (t1 - t0)) * plot.w,
      xToT: (x) => t0 + clamp((x - plot.x) / plot.w, 0, 1) * (t1 - t0),
      vToY: (v) => plot.y + (1 - (clamp(v, y0, y1) - y0) / (y1 - y0)) * plot.h };
    const off = document.createElement("canvas"); off.width = chart.cv.width; off.height = chart.cv.height;
    const lc = off.getContext("2d"); lc.scale(dpr, dpr); drawChartStatic(lc, chart, tel, sectorTs); chart.stat = off;
  }
  renderCharts(video.currentTime);
}
function drawChartStatic(c, chart, tel, sectorTs) {
  const def = chart.def, g = chart.geom, plot = g.plot;
  c.fillStyle = CHART_SURFACE; c.fillRect(0, 0, g.W, g.H); c.font = "10px ui-monospace, monospace";
  const step = def.step || niceStep(g.y1 - g.y0);
  c.textAlign = "right"; c.textBaseline = "middle";
  for (let v = g.y0; v <= g.y1 + 1e-9; v += step) { const y = Math.round(g.vToY(v)) + 0.5; c.strokeStyle = def.zero && Math.abs(v) < 1e-9 ? "#3a414a" : GRID; c.lineWidth = 1; c.beginPath(); c.moveTo(plot.x, y); c.lineTo(plot.x + plot.w, y); c.stroke(); c.fillStyle = AXIS_TEXT; c.fillText(String(v), plot.x - 6, y); }
  c.textAlign = "center"; c.textBaseline = "top";
  for (let lt = 60; lt < g.t1 - g.t0; lt += 60) { const x = Math.round(g.tToX(g.t0 + lt)) + 0.5; c.strokeStyle = GRID; c.beginPath(); c.moveTo(x, plot.y); c.lineTo(x, plot.y + plot.h); c.stroke(); if (def.timeAxis) { c.fillStyle = AXIS_TEXT; c.fillText(Math.floor(lt / 60) + ":00", x, plot.y + plot.h + 4); } }
  c.strokeStyle = "#343a42"; for (const st of sectorTs) { const x = Math.round(g.tToX(st)) + 0.5; c.beginPath(); c.moveTo(x, plot.y); c.lineTo(x, plot.y + plot.h); c.stroke(); }
  c.lineJoin = "round"; c.lineCap = "round";
  for (const s of def.series) { let vals = tel[s.field]; if (!vals) continue; if (def.smoothWin) vals = smoothArr(vals, def.smoothWin); c.lineWidth = def.lineWidth || 2; c.strokeStyle = s.color; c.beginPath(); for (let i = 0; i < tel.t.length; i++) { const x = g.tToX(tel.t[i]); const y = g.vToY(def.conv(vals[i])); i ? c.lineTo(x, y) : c.moveTo(x, y); } c.stroke(); }
}
function renderCharts(t) {
  const tel = state.chartsBuiltFor != null ? state.telemetryCache.get(state.chartsBuiltFor) : null;
  if (!tel) return;
  const labelT = state.hoverT != null ? state.hoverT : t;
  const ls = interpolate(tel, labelT);
  for (const chart of charts) {
    const g = chart.geom; if (!g || !chart.stat) continue; const c = chart.ctx2d;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, chart.cv.width, chart.cv.height); c.drawImage(chart.stat, 0, 0); c.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    if (state.hoverT != null && state.hoverT >= g.t0 && state.hoverT <= g.t1) { const hx = Math.round(g.tToX(state.hoverT)) + 0.5; c.strokeStyle = "#8b95a0"; c.globalAlpha = 0.4; c.lineWidth = 1; c.beginPath(); c.moveTo(hx, g.plot.y); c.lineTo(hx, g.plot.y + g.plot.h); c.stroke(); c.globalAlpha = 1; }
    if (t >= g.t0 && t <= g.t1) {
      const px = Math.round(g.tToX(t)) + 0.5; c.strokeStyle = ACCENT; c.lineWidth = 1; c.beginPath(); c.moveTo(px, g.plot.y); c.lineTo(px, g.plot.y + g.plot.h); c.stroke();
      const s = interpolate(tel, t);
      if (s) for (const sr of chart.def.series) { const v = chart.def.conv(s[sr.field]); if (v == null) continue; const y = g.vToY(v); c.beginPath(); c.arc(px - 0.5, y, 6, 0, 7); c.fillStyle = CHART_SURFACE; c.fill(); c.beginPath(); c.arc(px - 0.5, y, 4, 0, 7); c.fillStyle = sr.color; c.fill(); }
    }
    for (const sr of chart.def.series) { const el = $(sr.valueId); if (el) el.textContent = ls ? sr.fmt(ls[sr.field]) : "—"; }
  }
}
let chartDrag = false;
for (const chart of charts) {
  const el = chart.cv;
  const seek = (ev) => { if (!chart.geom) return; video.currentTime = chart.geom.xToT(ev.offsetX); };
  el.addEventListener("pointerdown", (ev) => { if (ev.button || !chart.geom) return; chartDrag = true; el.setPointerCapture(ev.pointerId); seek(ev); });
  el.addEventListener("pointermove", (ev) => { if (!chart.geom) return; if (chartDrag) { seek(ev); return; } state.hoverT = chart.geom.xToT(ev.offsetX); if (video.paused) renderCharts(video.currentTime); });
  const clear = () => { chartDrag = false; state.hoverT = null; if (video.paused) renderCharts(video.currentTime); };
  el.addEventListener("pointerup", () => { chartDrag = false; }); el.addEventListener("pointercancel", clear); el.addEventListener("pointerleave", clear);
}

/* ================= transport ================= */
const playBtn = $("play-btn"), playIcon = $("play-icon"), scrub = $("scrub"), scrubFill = $("scrub-fill"), scrubHandle = $("scrub-handle"), scrubBuffer = $("scrub-buffer"), timeReadout = $("time-readout");
playBtn.addEventListener("click", () => { if (video.paused) video.play().catch(() => {}); else video.pause(); });
video.addEventListener("play", () => { syncPlayBtn(); if (state.rafId == null) state.rafId = requestAnimationFrame(rafLoop); });
video.addEventListener("pause", syncPlayBtn);
function syncPlayBtn() {
  const playing = !video.paused;
  playIcon.innerHTML = playing ? '<rect x="2" y="1.5" width="3.5" height="11"></rect><rect x="8.5" y="1.5" width="3.5" height="11"></rect>' : '<path d="M3 1.5 12 7 3 12.5z"></path>';
  hud.rec.classList.toggle("is-live", playing);
}
let scrubDrag = false;
function scrubSeek(ev) { const r = scrub.getBoundingClientRect(); const f = clamp((ev.clientX - r.left) / r.width, 0, 1); if (video.duration) video.currentTime = f * video.duration; }
scrub.addEventListener("pointerdown", (ev) => { if (ev.button) return; scrubDrag = true; scrub.setPointerCapture(ev.pointerId); scrubSeek(ev); });
scrub.addEventListener("pointermove", (ev) => { if (scrubDrag) scrubSeek(ev); });
scrub.addEventListener("pointerup", () => { scrubDrag = false; });
scrub.addEventListener("pointercancel", () => { scrubDrag = false; });
function buildScrubTicks() {
  const host = $("scrub-ticks"); host.innerHTML = ""; const dur = video.duration; if (!dur) return;
  for (const lap of state.laps) { if (lap.videoOffsetSeconds <= 0) continue; const d = document.createElement("div"); d.className = "scrub-tick lap"; d.style.left = (lap.videoOffsetSeconds / dur * 100) + "%"; host.appendChild(d); }
  const full = state.laps.find((l) => l.isFullLap);
  if (full && full.sectors) for (const sec of full.sectors) { const d = document.createElement("div"); d.className = "scrub-tick sector"; d.style.left = (sec.offsetSeconds / dur * 100) + "%"; host.appendChild(d); }
}
function updateScrub() {
  const dur = video.duration; if (!dur) return;
  const f = video.currentTime / dur;
  scrubFill.style.width = (f * 100) + "%"; scrubHandle.style.left = (f * 100) + "%";
  if (video.buffered.length) { try { scrubBuffer.style.width = (video.buffered.end(video.buffered.length - 1) / dur * 100) + "%"; } catch (e) {} }
  timeReadout.textContent = fmtT(video.currentTime) + " / " + fmtT(dur);
}
document.addEventListener("keydown", (e) => {
  if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); if (video.paused) video.play().catch(() => {}); else video.pause(); }
  else if (e.code === "ArrowRight") { video.currentTime = Math.min((video.duration || 0), video.currentTime + 5); }
  else if (e.code === "ArrowLeft") { video.currentTime = Math.max(0, video.currentTime - 5); }
});

/* ================= corners ================= */
function distanceMeters(lat1, lon1, lat2, lon2, cosLat) { const dLat = (lat1 - lat2) * 110574; const dLon = (lon1 - lon2) * 111320 * cosLat; return Math.sqrt(dLat * dLat + dLon * dLon); }
const CORNER_MAX_M = 60;
function nearestCorner(lat, lon, cosLat) {
  if (!state.track) return "";
  let best = "", bd = CORNER_MAX_M;
  for (const curve of state.track.curves) for (const p of curve.points) { const d = distanceMeters(lat, lon, p.lat, p.lon, cosLat); if (d < bd) { bd = d; best = curve.name; } }
  return best;
}
const CURVE_RE = /^Curve\s+\d+\s*-\s*(.+)$/;
function stripCurve(desc) { const m = CURVE_RE.exec(desc || ""); return m ? m[1].trim() : (desc || ""); }

/* ================= main update ================= */
function updateDisplay() {
  const t = video.currentTime;
  const lap = findLapForTime(t); if (lap) setActiveLap(lap.lapNumber);
  const active = state.activeLapNumber;
  const tel = active != null ? state.telemetryCache.get(active) : null;
  if (!tel) { hud.speed.textContent = "—"; altValueEl.textContent = "—"; drawGBall(null, null); updateScrub(); return; }
  if (state.mapDrawnFor !== active) drawStaticTrack(tel);
  if (state.chartsBuiltFor !== active) buildCharts(tel, state.laps.find((l) => l.lapNumber === active));
  const s = interpolate(tel, t); state.lastSample = s;
  if (s) {
    const disp = Math.round(spConv(s.speedKmh));
    hud.speed.textContent = disp; hud.unit.textContent = spUnit();
    hud.timecode.textContent = fmtT(t);
    altValueEl.textContent = s.alt.toFixed(0);
    latgEl.textContent = signed(s.latG, 2); longEl.textContent = signed(s.lonG, 2);
    // corner name
    const name = state.mapProj ? nearestCorner(s.lat, s.lon, state.mapProj.cosLat) : "";
    hud.corner.textContent = name || "—"; hud.corner.classList.toggle("is-dim", !name);
    mapCornerEl.textContent = name || "—";
    // throttle / brake (derived from longitudinal G)
    if (s.lonG >= 0) { hud.throttle.style.width = (Math.min(1, s.lonG / 1.0) * 50) + "%"; hud.brake.style.width = "0%"; }
    else { hud.brake.style.width = (Math.min(1, -s.lonG / 1.2) * 50) + "%"; hud.throttle.style.width = "0%"; }
    drawGBall(s.latG, s.lonG);
    redrawTrack(s);
  }
  renderCharts(t);
  updateScrub();
}
function rafLoop() { updateDisplay(); state.rafId = video.paused ? null : requestAnimationFrame(rafLoop); }
video.addEventListener("timeupdate", updateDisplay);
video.addEventListener("seeked", updateDisplay);
video.addEventListener("loadedmetadata", () => { buildScrubTicks(); updateScrub(); });
video.addEventListener("durationchange", buildScrubTicks);

/* ================= layout / sizing ================= */
function layout() {
  const dpr = window.devicePixelRatio || 1; state.dpr = dpr;
  const mp = canvas.parentElement; state.cssW = mp.clientWidth; state.cssH = mp.clientHeight;
  canvas.width = Math.round(state.cssW * dpr); canvas.height = Math.round(state.cssH * dpr);
  gballCanvas.width = Math.round(116 * dpr); gballCanvas.height = Math.round(116 * dpr);
  const active = state.activeLapNumber;
  const tel = active != null ? state.telemetryCache.get(active) : null;
  if (tel) { drawStaticTrack(tel); buildCharts(tel, state.laps.find((l) => l.lapNumber === active)); }
  updateDisplay();
}
let roRaf = null;
const ro = new ResizeObserver(() => { if (roRaf) return; roRaf = requestAnimationFrame(() => { roRaf = null; layout(); }); });
ro.observe(canvas.parentElement); ro.observe($("chart-speed"));

/* ================= startup / session loading ================= */
async function loadTrack() {
  try {
    const res = await fetch("/api/track"); if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    data.curves = data.curves.map((c) => Object.assign({}, c, { name: stripCurve(c.description) }));
    state.track = data;
    if (state.mapDrawnFor != null) { drawStaticTrack(state.telemetryCache.get(state.mapDrawnFor)); redrawTrack(state.lastSample); }
  } catch (err) { console.error("track fetch failed", err); }
}

/* Reset everything lap/telemetry/track-related so switching sessions doesn't
 * leak state from the previous one. */
function resetSessionState() {
  state.laps = [];
  state.telemetryCache = new Map();
  state.activeLapNumber = null;
  state.track = null;
  state.mapDrawnFor = null;
  state.chartsBuiltFor = null;
  state.lastSample = null;
  pillsEl.innerHTML = "";
  state.pillEls = [];
  $("session-date").textContent = "—";
  $("kpi-top").textContent = "—";
  $("kpi-maxg").textContent = "—";
}

/* Loads laps + track for whichever session the server currently has active
 * (called once at startup, and again every time a new session is selected). */
async function loadSessionData() {
  try {
    const res = await fetch("/api/laps"); if (!res.ok) throw new Error("HTTP " + res.status);
    state.laps = await res.json();
    buildPills(); refreshSessionDate();
    loadTrack();
    const full = state.laps.find((l) => l.isFullLap) || state.laps[0];
    if (full) { const data = await ensureTelemetry(full.lapNumber); if (data && state.activeLapNumber == null) { state.activeLapNumber = full.lapNumber; highlightPill(full.lapNumber); refreshKpis(); } }
    requestAnimationFrame(layout);
  } catch (err) { console.error("laps fetch failed", err); }
}

/* ================= video status (preparing / error / raw-mkv notice) ================= */
const videoStatusEl = $("video-status");
const videoStatusTitle = $("video-status-title");
const videoStatusMessage = $("video-status-message");
const videoStatusBar = $("video-status-bar");
const videoStatusFill = $("video-status-fill");
const videoStatusDismiss = $("video-status-dismiss");
let statusPollTimer = null;
let rawNoticeDismissed = false;

function showVideoStatus(kind, title, message, percent) {
  videoStatusEl.hidden = false;
  videoStatusEl.className = "video-status video-status--" + kind;
  videoStatusTitle.textContent = title;
  videoStatusMessage.textContent = message || "";
  if (percent != null) { videoStatusBar.hidden = false; videoStatusFill.style.width = clamp(percent, 0, 100) + "%"; }
  else { videoStatusBar.hidden = true; }
  videoStatusDismiss.hidden = kind !== "notice";
}
function hideVideoStatus() { videoStatusEl.hidden = true; }
videoStatusDismiss.addEventListener("click", () => { rawNoticeDismissed = true; hideVideoStatus(); });

async function fetchSessionStatus() {
  const res = await fetch("/api/session/status");
  return res.json();
}

/* Applies the server's session/video state to the UI: shows a "preparing"
 * overlay while a remux is running (polling until it's done), an error
 * state, a dismissible notice when falling back to the raw .mkv, or just
 * wires up the video element once a playable URL is ready. */
async function applySessionStatus(status) {
  if (statusPollTimer != null) { clearTimeout(statusPollTimer); statusPollTimer = null; }
  if (!status || !status.active) { hideVideoStatus(); return; }

  if (status.status === "remuxing") {
    showVideoStatus("blocking", "Preparing video…",
      "Creating a browser-friendly copy of the recording (one-time, lossless remux — this session will start instantly next time).",
      status.percent);
    statusPollTimer = setTimeout(async () => { applySessionStatus(await fetchSessionStatus()); }, 1000);
    return;
  }
  if (status.status === "error") {
    showVideoStatus("blocking", "Video unavailable", status.message || "Could not prepare the video for this session.", null);
    return;
  }
  if (status.status === "raw" && !rawNoticeDismissed) {
    showVideoStatus("notice", "Playing original recording", status.message || "", null);
  } else {
    hideVideoStatus();
  }

  if (status.videoUrl && video.getAttribute("src") !== status.videoUrl) {
    video.pause();
    video.src = status.videoUrl;
    video.load();
  }
  await loadSessionData();
}

/* ================= folder picker ================= */
const folderModal = $("folder-modal");
const modalClose = $("modal-close");
const modalRoots = $("modal-roots");
const modalBreadcrumb = $("modal-breadcrumb");
const modalDirs = $("modal-dirs");
const modalSessions = $("modal-sessions");
const modalStatus = $("modal-status");
const modalUseBtn = $("modal-use-btn");

const folderState = { path: null, parent: null, dirs: [], sessions: [], roots: [], selectedSessionId: null };

function setModalStatus(msg, isError) {
  modalStatus.textContent = msg || "";
  modalStatus.classList.toggle("is-error", !!isError);
}

async function browseFolder(path) {
  setModalStatus("Loading…");
  try {
    const url = "/api/browse" + (path ? ("?path=" + encodeURIComponent(path)) : "");
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) { setModalStatus(data.error || "Could not open that folder.", true); return; }
    folderState.path = data.path;
    folderState.parent = data.parent;
    folderState.dirs = data.dirs;
    folderState.sessions = data.sessions;
    folderState.roots = data.roots;
    folderState.selectedSessionId = null;
    renderModal();
    setModalStatus("");
  } catch (err) { console.error("browse failed", err); setModalStatus("Could not reach the server.", true); }
}

function renderModal() {
  // roots (shortcut buttons)
  modalRoots.innerHTML = "";
  for (const root of folderState.roots) {
    const b = document.createElement("button");
    b.className = "modal-root-btn";
    b.textContent = root.label;
    b.addEventListener("click", () => browseFolder(root.path));
    modalRoots.appendChild(b);
  }

  // breadcrumb
  modalBreadcrumb.innerHTML = "";
  const up = document.createElement("button");
  up.className = "modal-up-btn";
  up.textContent = "↑ Up";
  up.disabled = !folderState.parent;
  up.addEventListener("click", () => { if (folderState.parent) browseFolder(folderState.parent); });
  modalBreadcrumb.appendChild(up);
  const pathEl = document.createElement("span");
  pathEl.className = "modal-path";
  pathEl.textContent = folderState.path || "";
  modalBreadcrumb.appendChild(pathEl);

  // subdirectories
  modalDirs.innerHTML = "";
  if (!folderState.dirs.length) {
    const empty = document.createElement("div");
    empty.className = "modal-dirs-empty";
    empty.textContent = "No subfolders.";
    modalDirs.appendChild(empty);
  }
  for (const dir of folderState.dirs) {
    const item = document.createElement("div");
    item.className = "modal-dir-item";
    item.textContent = dir.name;
    item.addEventListener("click", () => browseFolder(dir.path));
    modalDirs.appendChild(item);
  }

  // sessions detected in the current folder
  modalSessions.innerHTML = "";
  if (!folderState.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "modal-sessions-empty";
    empty.textContent = "No sessions found in this folder.";
    modalSessions.appendChild(empty);
  }
  for (const session of folderState.sessions) {
    const item = document.createElement("div");
    item.className = "modal-session-item";
    item.classList.toggle("is-selected", session.id === folderState.selectedSessionId);
    const title = document.createElement("div");
    title.className = "modal-session-title";
    const laps = session.laps || [];
    const full = laps.find((l) => l.isFullLap);
    title.innerHTML = "<span>" + session.videoFileName + "</span><span>" + session.lapCount + " lap" + (session.lapCount === 1 ? "" : "s") + "</span>";
    const meta = document.createElement("div");
    meta.className = "modal-session-meta";
    meta.textContent = session.dateTime + (session.hasCachedVideo ? " · cached video ready" : (session.hasVideoFile ? " · video needs preparing" : " · video file missing"));
    const lapsLine = document.createElement("div");
    lapsLine.className = "modal-session-laps";
    lapsLine.textContent = full ? ("Full lap: " + fmtLap(full.durationSeconds)) : laps.map((l) => "L" + l.lapNumber).join(", ");
    item.appendChild(title); item.appendChild(meta); item.appendChild(lapsLine);
    item.addEventListener("click", () => {
      folderState.selectedSessionId = session.id;
      for (const el of modalSessions.querySelectorAll(".modal-session-item")) el.classList.remove("is-selected");
      item.classList.add("is-selected");
      modalUseBtn.disabled = false;
    });
    modalSessions.appendChild(item);
  }
  modalUseBtn.disabled = !folderState.selectedSessionId;
}

async function selectSession(dir, id) {
  setModalStatus("Loading session…");
  modalUseBtn.disabled = true;
  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir, id }),
    });
    const data = await res.json();
    if (!res.ok) { setModalStatus(data.error || "Could not load that session.", true); modalUseBtn.disabled = false; return; }
    rawNoticeDismissed = false;
    closeFolderPicker();
    resetSessionState();
    await applySessionStatus(data);
  } catch (err) {
    console.error("session select failed", err);
    setModalStatus("Could not reach the server.", true);
    modalUseBtn.disabled = false;
  }
}

function openFolderPicker(dismissable) {
  folderModal.hidden = false;
  modalClose.hidden = !dismissable;
  browseFolder(folderState.path);
}
function closeFolderPicker() { folderModal.hidden = true; }

modalClose.addEventListener("click", closeFolderPicker);
modalUseBtn.addEventListener("click", () => { if (folderState.selectedSessionId) selectSession(folderState.path, folderState.selectedSessionId); });
$("folder-toggle").addEventListener("click", () => openFolderPicker(true));

/* ================= main startup ================= */
async function init() {
  buildMapToggle(); buildRates();
  drawGBall(null, null);
  try {
    const status = await fetchSessionStatus();
    if (!status.active) { openFolderPicker(false); return; }
    await applySessionStatus(status);
  } catch (err) {
    console.error("session status fetch failed", err);
    openFolderPicker(false);
  }
}
window.addEventListener("resize", layout);
init();
