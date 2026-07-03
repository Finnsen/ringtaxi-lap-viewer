"use strict";

/* RingTaxi Onboard — player logic.
 * Fetches laps + telemetry from the local API and synchronizes
 * video playback with speed/altitude/GPS track.
 */

const state = {
  laps: [],
  telemetryCache: new Map(), // lapNumber -> {t, speedKmh, lat, lon, alt, latG, lonG, vertG, heading}
  activeLapNumber: null,
  trackDrawnForLap: null,
  lastDot: null,        // last interpolated sample (for map redraw on hover)
  mapHover: null,       // {x, y} in canvas coordinates, nearest point under pointer
  chartsBuiltForLap: null,
  hoverT: null,         // shared crosshair time for the charts (null = no hover)
  rafId: null,
  track: null,          // {lines, curves} from /api/track (track geometry, static)
};

// Series colors — validated categorical palette (dataviz validator, all checks
// PASS against the surface #15181c). Must be kept in sync with style.css.
const SERIES = {
  speed: "#199e70",
  alt: "#3987e5",
  glat: "#d95926",
  glon: "#9085e9",
  vertg: "#b8860b",
};
const ACCENT = "#ff5f1f";      // ember — playhead/marker dot
const GRID = "#22262b";        // recessive hairline grid lines
const AXIS_TEXT = "#8d97a1";   // fog — axis/tick text
const CHART_SURFACE = "#0d1013";

const video = document.getElementById("player");
const lapListEl = document.getElementById("lap-list");
const speedValueEl = document.getElementById("speed-value");
const altValueEl = document.getElementById("alt-value");
const activeLapLabelEl = document.getElementById("active-lap-label");
const statusTextEl = document.getElementById("status-text");
const canvas = document.getElementById("track-canvas");
const ctx = canvas.getContext("2d");
const cornerNameEl = document.getElementById("corner-name");

function formatDuration(seconds) {
  const totalMs = Math.round(seconds * 1000);
  const m = Math.floor(totalMs / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function lapBadgeText(lap) {
  if (lap.isFullLap) return "Full lap";
  return lap.label === "In-lap" ? "In-lap" : "Out-lap";
}

function buildLapCard(lap) {
  const li = document.createElement("li");
  li.className = "lap-card" + (lap.isFullLap ? " is-full" : "");
  li.dataset.lapNumber = String(lap.lapNumber);
  li.tabIndex = 0;
  li.setAttribute("role", "button");

  const row = document.createElement("div");
  row.className = "lap-row";
  const number = document.createElement("span");
  number.className = "lap-number";
  number.textContent = `L${lap.lapNumber}`;
  const duration = document.createElement("span");
  duration.className = "lap-duration";
  duration.textContent = formatDuration(lap.durationSeconds);
  row.appendChild(number);
  row.appendChild(duration);
  li.appendChild(row);

  const badge = document.createElement("span");
  badge.className = "lap-badge";
  badge.textContent = lapBadgeText(lap);
  li.appendChild(badge);

  if (lap.isFullLap && lap.sectors.length > 0) {
    const sectorsEl = document.createElement("div");
    sectorsEl.className = "lap-sectors";
    for (const sec of lap.sectors) {
      const cell = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = `S${sec.sectorNumber}`;
      cell.appendChild(label);
      cell.appendChild(document.createTextNode(formatDuration(sec.durationSeconds)));
      sectorsEl.appendChild(cell);
    }
    li.appendChild(sectorsEl);
  }

  function activate() {
    video.currentTime = lap.videoOffsetSeconds;
    video.play().catch(() => {});
    setActiveLap(lap.lapNumber);
  }
  li.addEventListener("click", activate);
  li.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      activate();
    }
  });

  return li;
}

function renderLapList() {
  lapListEl.innerHTML = "";
  for (const lap of state.laps) {
    lapListEl.appendChild(buildLapCard(lap));
  }
}

function setActiveLap(lapNumber) {
  if (state.activeLapNumber === lapNumber) return;
  state.activeLapNumber = lapNumber;
  for (const card of lapListEl.children) {
    card.classList.toggle("is-active", Number(card.dataset.lapNumber) === lapNumber);
  }
  const lap = state.laps.find((l) => l.lapNumber === lapNumber);
  activeLapLabelEl.textContent = lap ? `${lap.label} · Lap ${lap.lapNumber}` : "No lap selected";
  ensureTelemetry(lapNumber);
}

function findLapForTime(t) {
  for (const lap of state.laps) {
    const start = lap.videoOffsetSeconds;
    const end = start + lap.durationSeconds;
    if (t >= start - 0.05 && t < end + 0.05) return lap;
  }
  return null;
}

async function ensureTelemetry(lapNumber) {
  if (state.telemetryCache.has(lapNumber)) return state.telemetryCache.get(lapNumber);
  try {
    const res = await fetch(`/api/telemetry/${lapNumber}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.telemetryCache.set(lapNumber, data);
    if (state.activeLapNumber === lapNumber) {
      drawStaticTrack(data);
      buildCharts(data, state.laps.find((l) => l.lapNumber === lapNumber));
    }
    return data;
  } catch (err) {
    console.error("Could not fetch telemetry for lap", lapNumber, err);
    return null;
  }
}

// --- Binary search + interpolation in the telemetry array ---

// Interpolates an angle (degrees, 0-360) along the shortest path across the
// 0/360 wraparound, e.g. lerpAngle(350, 10, 0.5) === 0 (not 180).
function lerpAngle(a, b, frac) {
  const diff = ((b - a + 540) % 360) - 180;
  return (a + diff * frac + 360) % 360;
}

function interpolate(telemetry, t) {
  const arr = telemetry.t;
  if (!arr || arr.length === 0) return null;
  if (t <= arr[0]) return sampleAt(telemetry, 0);
  if (t >= arr[arr.length - 1]) return sampleAt(telemetry, arr.length - 1);

  let lo = 0;
  let hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) lo = mid; else hi = mid;
  }
  const t0 = arr[lo];
  const t1 = arr[hi];
  const frac = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const lerp = (a, b) => a + (b - a) * frac;
  return {
    speedKmh: lerp(telemetry.speedKmh[lo], telemetry.speedKmh[hi]),
    lat: lerp(telemetry.lat[lo], telemetry.lat[hi]),
    lon: lerp(telemetry.lon[lo], telemetry.lon[hi]),
    alt: lerp(telemetry.alt[lo], telemetry.alt[hi]),
    latG: lerp(telemetry.latG[lo], telemetry.latG[hi]),
    lonG: lerp(telemetry.lonG[lo], telemetry.lonG[hi]),
    vertG: lerp(telemetry.vertG[lo], telemetry.vertG[hi]),
    heading: lerpAngle(telemetry.heading[lo], telemetry.heading[hi], frac),
  };
}

function sampleAt(telemetry, i) {
  return {
    speedKmh: telemetry.speedKmh[i],
    lat: telemetry.lat[i],
    lon: telemetry.lon[i],
    alt: telemetry.alt[i],
    latG: telemetry.latG[i],
    lonG: telemetry.lonG[i],
    vertG: telemetry.vertG[i],
    heading: telemetry.heading[i],
  };
}

// --- Map / GPS track (equirectangular projection) ---

function projectPoints(telemetry) {
  const lats = telemetry.lat;
  const lons = telemetry.lon;
  if (lats.length === 0) return null;
  const avgLat = lats.reduce((a, b) => a + b, 0) / lats.length;
  const cosLat = Math.cos((avgLat * Math.PI) / 180);

  const xs = lons.map((lon) => lon * cosLat);
  const ys = lats.map((lat) => -lat); // north up

  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);

  return { xs, ys, minX, minY, spanX, spanY, avgLat, cosLat };
}

function toCanvasXY(proj, lat, lon, width, height, pad) {
  const x = lon * proj.cosLat;
  const y = -lat;
  const usableW = width - pad * 2;
  const usableH = height - pad * 2;
  const scale = Math.min(usableW / proj.spanX, usableH / proj.spanY);
  const offsetX = pad + (usableW - proj.spanX * scale) / 2;
  const offsetY = pad + (usableH - proj.spanY * scale) / 2;
  return {
    x: offsetX + (x - proj.minX) * scale,
    y: offsetY + (y - proj.minY) * scale,
  };
}

let currentProjection = null;

function drawStaticTrack(telemetry) {
  const proj = projectPoints(telemetry);
  currentProjection = proj;
  state.trackDrawnForLap = telemetry.lapNumber;
  redrawTrack(null);
}

const MAP_PAD = 28;

// Lines from /api/track — start/finish in accent color, sector lines muted.
function drawTrackLines(proj, width, height) {
  if (!state.track) return;
  for (const line of state.track.lines) {
    const pts = line.points.map((p) => toCanvasXY(proj, p.lat, p.lon, width, height, MAP_PAD));
    if (pts.length < 2) continue;
    ctx.strokeStyle = line.kind === "sector" ? "#5a626c" : ACCENT;
    ctx.globalAlpha = line.kind === "sector" ? 0.55 : 0.85;
    ctx.lineWidth = line.kind === "sector" ? 1.5 : 2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const mid = pts[Math.floor(pts.length / 2)];
    ctx.fillStyle = line.kind === "sector" ? AXIS_TEXT : ACCENT;
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(line.label, mid.x, mid.y - 8);
  }
}

// Direction arrow (triangle) rotated to match the heading (dr, 0-360 compass degrees).
// Compass 0deg = north = "up" on the map (y up), and canvas' rotate() rotates
// clockwise for positive angles when y points down — the same direction as the
// compass, so the angle can be used directly without conversion.
function drawHeadingArrow(x, y, headingDeg) {
  const r = 8;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((headingDeg * Math.PI) / 180);
  ctx.fillStyle = ACCENT;
  ctx.shadowColor = "rgba(255, 95, 31, 0.8)";
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.62, r * 0.75);
  ctx.lineTo(-r * 0.62, r * 0.75);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
}

// Equirectangular distance in meters — same projection as the rest of the map.
function distanceMeters(lat1, lon1, lat2, lon2, cosLat) {
  const dLat = (lat1 - lat2) * 110574;
  const dLon = (lon1 - lon2) * 111320 * cosLat;
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

const CORNER_MAX_DISTANCE_M = 60;

function nearestCornerName(lat, lon, cosLat) {
  if (!state.track) return "";
  let bestName = "";
  let bestD = CORNER_MAX_DISTANCE_M;
  for (const curve of state.track.curves) {
    for (const p of curve.points) {
      const d = distanceMeters(lat, lon, p.lat, p.lon, cosLat);
      if (d < bestD) {
        bestD = d;
        bestName = curve.name;
      }
    }
  }
  return bestName;
}

function redrawTrack(dot) {
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  state.lastDot = dot;

  if (!currentProjection) return;
  const proj = currentProjection;
  const telemetry = state.telemetryCache.get(state.trackDrawnForLap);

  drawTrackLines(proj, width, height);

  ctx.strokeStyle = "#8fffb0";
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < telemetry.lat.length; i++) {
    const p = toCanvasXY(proj, telemetry.lat[i], telemetry.lon[i], width, height, MAP_PAD);
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (state.mapHover) {
    ctx.strokeStyle = "#e7eaed";
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(state.mapHover.x, state.mapHover.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (dot) {
    const p = toCanvasXY(proj, dot.lat, dot.lon, width, height, MAP_PAD);
    if (dot.heading != null) {
      drawHeadingArrow(p.x, p.y, dot.heading);
    } else {
      ctx.fillStyle = ACCENT;
      ctx.shadowColor = "rgba(255, 95, 31, 0.8)";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    if (cornerNameEl) {
      const name = nearestCornerName(dot.lat, dot.lon, proj.cosLat);
      cornerNameEl.textContent = name || "–";
      cornerNameEl.classList.toggle("is-dim", !name);
    }
  }
}

// --- Click-to-seek on the map ---

const MAP_HIT_MAX = 24; // max distance (canvas pixels) for a hit

function mapEventToCanvasXY(ev) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) / rect.width) * canvas.width,
    y: ((ev.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function nearestTelemetryPoint(x, y) {
  if (!currentProjection) return null;
  const telemetry = state.telemetryCache.get(state.trackDrawnForLap);
  if (!telemetry) return null;
  const { width, height } = canvas;
  let bestI = -1;
  let bestD2 = MAP_HIT_MAX * MAP_HIT_MAX;
  for (let i = 0; i < telemetry.lat.length; i++) {
    const p = toCanvasXY(currentProjection, telemetry.lat[i], telemetry.lon[i], width, height, MAP_PAD);
    const dx = p.x - x;
    const dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestI = i;
    }
  }
  if (bestI < 0) return null;
  const p = toCanvasXY(currentProjection, telemetry.lat[bestI], telemetry.lon[bestI], width, height, MAP_PAD);
  return { index: bestI, t: telemetry.t[bestI], x: p.x, y: p.y };
}

let mapDragging = false;

function mapSeek(ev) {
  const { x, y } = mapEventToCanvasXY(ev);
  const hit = nearestTelemetryPoint(x, y);
  if (hit) {
    video.currentTime = hit.t;
    state.mapHover = { x: hit.x, y: hit.y };
  }
  return hit;
}

canvas.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0) return;
  if (mapSeek(ev)) {
    mapDragging = true;
    canvas.setPointerCapture(ev.pointerId);
  }
});

canvas.addEventListener("pointermove", (ev) => {
  if (mapDragging) {
    mapSeek(ev);
    return;
  }
  const { x, y } = mapEventToCanvasXY(ev);
  const hit = nearestTelemetryPoint(x, y);
  state.mapHover = hit ? { x: hit.x, y: hit.y } : null;
  if (video.paused) redrawTrack(state.lastDot);
});

function endMapDrag(ev) {
  mapDragging = false;
  if (ev.type === "pointerleave") {
    state.mapHover = null;
    if (video.paused) redrawTrack(state.lastDot);
  }
}
canvas.addEventListener("pointerup", endMapDrag);
canvas.addEventListener("pointercancel", endMapDrag);
canvas.addEventListener("pointerleave", endMapDrag);

// --- G-ball (friction circle) ---

const gballCanvas = document.getElementById("gball-canvas");
const gballCtx = gballCanvas.getContext("2d");
const gballLatEl = document.getElementById("gball-lat");
const gballLonEl = document.getElementById("gball-lon");

const GBALL_MAX_G = 2.0;   // visning klippes hit
const GBALL_RING_G = [0.5, 1.0, 1.5];

function drawGBall(latG, lonG) {
  const w = gballCanvas.width;
  const h = gballCanvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const rMax = Math.min(w, h) / 2 - 10;      // radius corresponding to GBALL_MAX_G
  const scale = rMax / GBALL_MAX_G;

  gballCtx.clearRect(0, 0, w, h);

  // Axis cross (hairline, recessive)
  gballCtx.strokeStyle = GRID;
  gballCtx.lineWidth = 1;
  gballCtx.beginPath();
  gballCtx.moveTo(cx - rMax, cy);
  gballCtx.lineTo(cx + rMax, cy);
  gballCtx.moveTo(cx, cy - rMax);
  gballCtx.lineTo(cx, cy + rMax);
  gballCtx.stroke();

  // Concentric rings at 0.5 / 1.0 / 1.5 g
  for (const g of GBALL_RING_G) {
    gballCtx.strokeStyle = g === 1.0 ? "#343a42" : GRID;
    gballCtx.beginPath();
    gballCtx.arc(cx, cy, g * scale, 0, Math.PI * 2);
    gballCtx.stroke();
  }

  // Ring labels + axis direction (text in text color, never series color)
  gballCtx.fillStyle = AXIS_TEXT;
  gballCtx.font = "10px ui-monospace, monospace";
  gballCtx.textAlign = "left";
  gballCtx.textBaseline = "bottom";
  for (const g of GBALL_RING_G) {
    gballCtx.fillText(g.toFixed(1), cx + 3, cy - g * scale - 1);
  }
  gballCtx.textAlign = "center";
  gballCtx.textBaseline = "top";
  gballCtx.fillText("throttle", cx - rMax * 0.62, cy - rMax * 0.98);
  gballCtx.textBaseline = "bottom";
  gballCtx.fillText("brake", cx - rMax * 0.60, cy + rMax * 1.04);
  gballCtx.textAlign = "right";
  gballCtx.textBaseline = "middle";
  gballCtx.fillText("±g lat", cx + rMax, cy + 10);

  if (latG == null || lonG == null) return;

  // Clip to the display range. Convention: x = lateral (sign unmarked,
  // see README), y = longitudinal with throttle up / brake down (lo < 0 = brake).
  const gx = Math.max(-GBALL_MAX_G, Math.min(GBALL_MAX_G, latG));
  const gy = Math.max(-GBALL_MAX_G, Math.min(GBALL_MAX_G, lonG));
  const px = cx + gx * scale;
  const py = cy - gy * scale;

  // Dot >=8px with 2px flattening so it reads over the rings
  gballCtx.beginPath();
  gballCtx.arc(px, py, 7, 0, Math.PI * 2);
  gballCtx.fillStyle = "#15181c";
  gballCtx.fill();
  gballCtx.beginPath();
  gballCtx.arc(px, py, 5, 0, Math.PI * 2);
  gballCtx.fillStyle = ACCENT;
  gballCtx.fill();
}

function formatSigned(v, decimals) {
  const s = v.toFixed(decimals);
  return v >= 0 ? "+" + s : s;
}

function updateGBall(sample) {
  if (!sample || sample.latG == null) {
    drawGBall(null, null);
    gballLatEl.textContent = "–";
    gballLonEl.textContent = "–";
    return;
  }
  drawGBall(sample.latG, sample.lonG);
  gballLatEl.textContent = formatSigned(sample.latG, 2);
  gballLonEl.textContent = formatSigned(sample.lonG, 2);
}

drawGBall(null, null);

// --- Time-series charts (speed / altitude / g-forces) ---

const CHART_DEFS = [
  {
    id: "chart-speed",
    series: [{ field: "speedKmh", color: SERIES.speed, valueId: "chart-value-speed",
               fmt: (v) => String(Math.round(v)) }],
    domain(tel) {
      const max = Math.max(...tel.speedKmh);
      return [0, Math.max(50, Math.ceil(max / 50) * 50)];
    },
    tickStep: 50,
    timeAxis: false,
  },
  {
    id: "chart-alt",
    series: [{ field: "alt", color: SERIES.alt, valueId: "chart-value-alt",
               fmt: (v) => v.toFixed(1) }],
    domain(tel) {
      const min = Math.min(...tel.alt);
      const max = Math.max(...tel.alt);
      const step = niceStep(max - min);
      return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
    },
    tickStep: null, // beregnes fra domenet
    timeAxis: false,
  },
  {
    id: "chart-g",
    series: [
      { field: "latG", color: SERIES.glat, valueId: "chart-value-glat",
        fmt: (v) => formatSigned(v, 2) },
      { field: "lonG", color: SERIES.glon, valueId: "chart-value-glon",
        fmt: (v) => formatSigned(v, 2) },
      { field: "vertG", color: SERIES.vertg, valueId: "chart-value-vertg",
        fmt: (v) => formatSigned(v, 2) },
    ],
    domain() { return [-2, 2]; },
    tickStep: 1,
    timeAxis: true,
    zeroLine: true,
  },
];

function niceStep(range) {
  const target = range / 4;
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200]) {
    if (s >= target) return s;
  }
  return 500;
}

const charts = []; // {def, canvasEl, ctx2d, staticLayer, geom, valueEls}

for (const def of CHART_DEFS) {
  const root = document.getElementById(def.id);
  const canvasEl = root.querySelector(".chart-canvas");
  charts.push({
    def,
    canvasEl,
    ctx2d: canvasEl.getContext("2d"),
    staticLayer: null,
    geom: null,
    valueEls: def.series.map((s) => document.getElementById(s.valueId)),
  });
}

const CHART_MARGIN = { left: 40, right: 10, top: 8 };

function buildCharts(telemetry, lap) {
  state.chartsBuiltForLap = telemetry.lapNumber;
  const tArr = telemetry.t;
  if (!tArr || tArr.length < 2) return;
  const t0 = tArr[0];
  const t1 = tArr[tArr.length - 1];

  // Sector boundaries (full laps only) as discrete vertical grid lines.
  const sectorTs = [];
  if (lap && lap.isFullLap) {
    for (const sec of lap.sectors) {
      const st = sec.offsetSeconds;
      if (st > t0 + 1 && st < t1 - 1) sectorTs.push(st);
    }
  }

  const dpr = window.devicePixelRatio || 1;

  for (const chart of charts) {
    const def = chart.def;
    const cssW = chart.canvasEl.clientWidth || 800;
    const cssH = Number(chart.canvasEl.getAttribute("height"));
    chart.canvasEl.width = Math.round(cssW * dpr);
    chart.canvasEl.height = Math.round(cssH * dpr);

    const bottom = def.timeAxis ? 20 : 8;
    const plot = {
      x: CHART_MARGIN.left,
      y: CHART_MARGIN.top,
      w: cssW - CHART_MARGIN.left - CHART_MARGIN.right,
      h: cssH - CHART_MARGIN.top - bottom,
    };
    const [y0, y1] = def.domain(telemetry);
    chart.geom = {
      dpr, cssW, cssH, plot, t0, t1, y0, y1,
      tToX: (t) => plot.x + ((t - t0) / (t1 - t0)) * plot.w,
      xToT: (x) => t0 + Math.max(0, Math.min(1, (x - plot.x) / plot.w)) * (t1 - t0),
      vToY: (v) => plot.y + (1 - (Math.max(y0, Math.min(y1, v)) - y0) / (y1 - y0)) * plot.h,
    };

    // Static layer (grid + series + axes) is drawn once in an offscreen canvas.
    const layer = document.createElement("canvas");
    layer.width = chart.canvasEl.width;
    layer.height = chart.canvasEl.height;
    const lctx = layer.getContext("2d");
    lctx.scale(dpr, dpr);
    drawChartStatic(lctx, chart, telemetry, sectorTs);
    chart.staticLayer = layer;
  }
  renderCharts(video.currentTime);
}

function drawChartStatic(c, chart, telemetry, sectorTs) {
  const { def } = chart;
  const g = chart.geom;
  const { plot } = g;

  c.fillStyle = CHART_SURFACE;
  c.fillRect(0, 0, g.cssW, g.cssH);
  c.font = "10px ui-monospace, monospace";

  // Y grid lines + ticks (plain numbers, recessive hairlines)
  const step = def.tickStep || niceStep(g.y1 - g.y0);
  c.textAlign = "right";
  c.textBaseline = "middle";
  for (let v = g.y0; v <= g.y1 + 1e-9; v += step) {
    const y = Math.round(g.vToY(v)) + 0.5;
    c.strokeStyle = def.zeroLine && Math.abs(v) < 1e-9 ? "#3a414a" : GRID;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(plot.x, y);
    c.lineTo(plot.x + plot.w, y);
    c.stroke();
    c.fillStyle = AXIS_TEXT;
    c.fillText(String(v), plot.x - 6, y);
  }

  // Time ticks every 60th second (lap time m:ss); grid line in all charts,
  // label only in the chart with a time axis.
  c.textAlign = "center";
  c.textBaseline = "top";
  for (let lapT = 60; lapT < g.t1 - g.t0; lapT += 60) {
    const x = Math.round(g.tToX(g.t0 + lapT)) + 0.5;
    c.strokeStyle = GRID;
    c.beginPath();
    c.moveTo(x, plot.y);
    c.lineTo(x, plot.y + plot.h);
    c.stroke();
    if (def.timeAxis) {
      c.fillStyle = AXIS_TEXT;
      c.fillText(`${Math.floor(lapT / 60)}:00`, x, plot.y + plot.h + 4);
    }
  }

  // Sector boundaries — slightly more prominent than regular grid lines, still recessive
  c.strokeStyle = "#343a42";
  for (const st of sectorTs) {
    const x = Math.round(g.tToX(st)) + 0.5;
    c.beginPath();
    c.moveTo(x, plot.y);
    c.lineTo(x, plot.y + plot.h);
    c.stroke();
  }

  // Series: 2px lines, rounded joins
  c.lineWidth = 2;
  c.lineJoin = "round";
  c.lineCap = "round";
  for (const s of def.series) {
    const values = telemetry[s.field];
    if (!values) continue;
    c.strokeStyle = s.color;
    c.beginPath();
    for (let i = 0; i < telemetry.t.length; i++) {
      const x = g.tToX(telemetry.t[i]);
      const y = g.vToY(values[i]);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }
}

function renderCharts(t) {
  const telemetry = state.chartsBuiltForLap != null
    ? state.telemetryCache.get(state.chartsBuiltForLap) : null;
  if (!telemetry) return;
  const labelT = state.hoverT != null ? state.hoverT : t;
  const labelSample = interpolate(telemetry, labelT);

  for (const chart of charts) {
    const g = chart.geom;
    if (!g || !chart.staticLayer) continue;
    const c = chart.ctx2d;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(chart.staticLayer, 0, 0);
    c.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);

    // Hover crosshair (shared across all charts)
    if (state.hoverT != null && state.hoverT >= g.t0 && state.hoverT <= g.t1) {
      const hx = Math.round(g.tToX(state.hoverT)) + 0.5;
      c.strokeStyle = AXIS_TEXT;
      c.globalAlpha = 0.4;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(hx, g.plot.y);
      c.lineTo(hx, g.plot.y + g.plot.h);
      c.stroke();
      c.globalAlpha = 1;
    }

    // Playhead following playback
    if (t >= g.t0 && t <= g.t1) {
      const px = Math.round(g.tToX(t)) + 0.5;
      c.strokeStyle = ACCENT;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(px, g.plot.y);
      c.lineTo(px, g.plot.y + g.plot.h);
      c.stroke();

      const sample = interpolate(telemetry, t);
      if (sample) {
        for (const s of chart.def.series) {
          const v = sample[s.field];
          if (v == null) continue;
          const y = g.vToY(v);
          // >=8px marker with 2px flattening
          c.beginPath();
          c.arc(px - 0.5, y, 6, 0, Math.PI * 2);
          c.fillStyle = CHART_SURFACE;
          c.fill();
          c.beginPath();
          c.arc(px - 0.5, y, 4, 0, Math.PI * 2);
          c.fillStyle = s.color;
          c.fill();
        }
      }
    }

    // Value at the playhead (or hover) in the chart's label row
    for (let i = 0; i < chart.def.series.length; i++) {
      const s = chart.def.series[i];
      const v = labelSample ? labelSample[s.field] : null;
      chart.valueEls[i].textContent = v == null ? "–" : s.fmt(v);
    }
  }
}

// Click/drag in a chart seeks the video; hover shows a synced crosshair + value.
let chartDragging = false;

function chartSeek(chart, ev) {
  const g = chart.geom;
  if (!g) return;
  video.currentTime = g.xToT(ev.offsetX);
}

for (const chart of charts) {
  const el = chart.canvasEl;
  el.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !chart.geom) return;
    chartDragging = true;
    el.setPointerCapture(ev.pointerId);
    chartSeek(chart, ev);
  });
  el.addEventListener("pointermove", (ev) => {
    if (!chart.geom) return;
    if (chartDragging) {
      chartSeek(chart, ev);
      return;
    }
    state.hoverT = chart.geom.xToT(ev.offsetX);
    if (video.paused) renderCharts(video.currentTime);
  });
  const clearHover = (ev) => {
    chartDragging = false;
    state.hoverT = null;
    if (video.paused) renderCharts(video.currentTime);
  };
  el.addEventListener("pointerup", () => { chartDragging = false; });
  el.addEventListener("pointercancel", clearHover);
  el.addEventListener("pointerleave", clearHover);
}

window.addEventListener("resize", () => {
  const telemetry = state.chartsBuiltForLap != null
    ? state.telemetryCache.get(state.chartsBuiltForLap) : null;
  if (!telemetry) return;
  const lap = state.laps.find((l) => l.lapNumber === telemetry.lapNumber);
  buildCharts(telemetry, lap);
});

// --- Video events ---

function updateDisplay() {
  const t = video.currentTime;
  const lap = findLapForTime(t);
  if (lap) setActiveLap(lap.lapNumber);

  const activeLapNumber = state.activeLapNumber;
  const telemetry = activeLapNumber != null ? state.telemetryCache.get(activeLapNumber) : null;
  if (!telemetry) {
    speedValueEl.textContent = "–";
    altValueEl.textContent = "–";
    updateGBall(null);
    return;
  }

  if (state.trackDrawnForLap !== activeLapNumber) {
    drawStaticTrack(telemetry);
  }
  if (state.chartsBuiltForLap !== activeLapNumber) {
    const activeLap = state.laps.find((l) => l.lapNumber === activeLapNumber);
    buildCharts(telemetry, activeLap);
  }

  const sample = interpolate(telemetry, t);
  if (sample) {
    speedValueEl.textContent = Math.round(sample.speedKmh).toString();
    altValueEl.textContent = sample.alt.toFixed(1);
    redrawTrack(sample);
    updateGBall(sample);
  }
  renderCharts(t);
}

// requestAnimationFrame loop during playback gives a smooth playhead/dot;
// timeupdate alone (~4 Hz) covers seeking while the video is paused.
function rafLoop() {
  updateDisplay();
  state.rafId = video.paused ? null : requestAnimationFrame(rafLoop);
}

video.addEventListener("play", () => {
  if (state.rafId == null) state.rafId = requestAnimationFrame(rafLoop);
});
video.addEventListener("timeupdate", updateDisplay);
video.addEventListener("seeked", updateDisplay);

// --- Startup ---

// «Curve 12 - Aremberg» -> «Aremberg»; without a name («Curve 81») is kept as is.
const CURVE_NAME_RE = /^Curve\s+\d+\s*-\s*(.+)$/;

function stripCurveName(description) {
  const m = CURVE_NAME_RE.exec(description || "");
  return m ? m[1].trim() : (description || "");
}

async function loadTrack() {
  try {
    const res = await fetch("/api/track");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    data.curves = data.curves.map((c) => ({ ...c, name: stripCurveName(c.description) }));
    state.track = data;
    if (state.trackDrawnForLap != null) redrawTrack(state.lastDot);
  } catch (err) {
    console.error("Could not fetch track geometry", err);
  }
}

async function init() {
  try {
    const res = await fetch("/api/laps");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.laps = await res.json();
    renderLapList();
    statusTextEl.textContent = `${state.laps.length} laps loaded`;

    loadTrack();

    const fullLap = state.laps.find((l) => l.isFullLap);
    if (fullLap) {
      const data = await ensureTelemetry(fullLap.lapNumber);
      // Pre-render track and charts for the full lap before playback starts.
      if (data && state.activeLapNumber == null) {
        drawStaticTrack(data);
        buildCharts(data, fullLap);
      }
    }
  } catch (err) {
    statusTextEl.textContent = "Failed to load laps: " + err.message;
    console.error(err);
  }
}

init();
