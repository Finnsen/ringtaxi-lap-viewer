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
  mapStyle: "none",            // 'none' | 'map' | 'satellite' (Leaflet base layer)
  hoverT: null,
  mapHover: null,
  lastSample: null,
  rafId: null,
  mapCosLat: null,             // avg cos(lat) of the active lap, for corner-distance calcs
  mapDrawnFor: null,
  chartsBuiltFor: null,
  pendingBoundsPoints: null,
  cameraMode: "free",          // 'free' | 'follow-north' | 'follow-heading'
  rotateAvailable: false,      // true once leaflet-rotate has patched L.Map with setBearing
  trackMinZoom: null,          // the zoom that fits the whole track (also the floor for all modes)
  trackPaddedBounds: null,     // padded L.LatLngBounds of the track, reused when returning to Free
  followZoom: null,            // user-adjustable zoom used while in either Follow mode
  currentBearingDeg: 0,        // map bearing applied this frame (0 outside follow-heading)
};

/* ---- DOM ---- */
const $ = (id) => document.getElementById(id);
const video = $("player");
const pillsEl = $("lap-pills");
const hud = { speed: $("hud-speed"), unit: $("hud-speed-unit"), corner: $("hud-corner"), timecode: $("hud-timecode"), rec: $("rec-dot"), brake: $("hud-brake"), throttle: $("hud-throttle") };
const altValueEl = $("alt-value"), latgEl = $("latg-value"), longEl = $("long-value");
const mapCornerEl = $("map-corner");
const gballCanvas = $("gball-canvas"), gctx = gballCanvas.getContext("2d");
const fsGballWrap = $("hud-gball"), fsGballCanvas = $("hud-gball-canvas"), fsGctx = fsGballCanvas.getContext("2d");

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
  [["none", "None"], ["map", "Map"], ["satellite", "Sat"]].forEach(([v, lbl]) => {
    const b = document.createElement("button");
    b.textContent = lbl; b.dataset.v = v;
    b.addEventListener("click", () => applyMapStyle(v));
    host.appendChild(b);
  });
  updateMapToggleButtons();
}
function updateMapToggleButtons() {
  const host = $("map-toggle");
  for (const c of host.children) c.classList.toggle("is-active", c.dataset.v === state.mapStyle);
}

/* Camera-mode control - a second, visually distinct button group (own
 * rounded pill, placed under the base-layer toggle) so the two independent
 * choices (base layer vs. camera behavior) don't look like one control. */
function buildCameraToggle() {
  const host = $("camera-toggle"); host.innerHTML = "";
  const opts = [
    ["free", "Free", "Free — pan/zoom manually, fitted to the whole track"],
    ["follow-north", "Follow", "Follow — camera tracks the car, north stays up"],
  ];
  if (state.rotateAvailable) opts.push(["follow-heading", "Nav", "Follow — camera tracks the car, heading stays up (car-nav style)"]);
  opts.forEach(([v, lbl, title]) => {
    const b = document.createElement("button");
    b.textContent = lbl; b.dataset.v = v; b.title = title;
    b.addEventListener("click", () => applyCameraMode(v));
    host.appendChild(b);
  });
  updateCameraToggleButtons();
}
function updateCameraToggleButtons() {
  const host = $("camera-toggle");
  for (const c of host.children) c.classList.toggle("is-active", c.dataset.v === state.cameraMode);
}
function clampFollowZoom(z) {
  const lo = state.trackMinZoom != null ? state.trackMinZoom : 0;
  return clamp(z, lo, 19);
}

/* Switches camera behavior. Free = current manual pan/zoom clamped to the
 * track bounds (unchanged behavior). Follow modes recenter on the car every
 * frame (see updateCamera, driven by the rAF loop) and disable manual
 * dragging entirely so a stray drag can't fight the camera; maxBounds is
 * relaxed in follow modes since centering near the track edge at high zoom
 * would otherwise fight the bounds clamp (minZoom stays the track-fit zoom
 * in all modes). Switching *into* a follow mode jumps straight to the
 * follow-zoom; switching *back to* Free resets bearing and refits the track
 * (this refit only happens on the mode switch, not every frame). */
function applyCameraMode(mode) {
  if (mode === "follow-heading" && !state.rotateAvailable) mode = "follow-north"; // degrade gracefully
  state.cameraMode = mode;
  try { localStorage.setItem("rnv-camera-mode", mode); } catch (err) { /* not persisted, still works */ }
  updateCameraToggleButtons();
  if (!state.map) return;

  if (mode === "free") {
    state.map.dragging.enable();
    if (state.rotateAvailable) state.map.setBearing(0);
    state.currentBearingDeg = 0;
    if (state.trackMinZoom != null) state.map.setMinZoom(state.trackMinZoom);
    state.map.setMaxBounds(state.trackPaddedBounds || null);
    if (state.trackPaddedBounds) state.map.fitBounds(state.trackPaddedBounds, { animate: false });
    return;
  }

  // follow-north / follow-heading
  state.map.dragging.disable();
  state.map.setMaxBounds(null);
  if (state.trackMinZoom != null) state.map.setMinZoom(state.trackMinZoom);
  if (mode === "follow-north" && state.rotateAvailable) state.map.setBearing(0);
  if (mode === "follow-north") state.currentBearingDeg = 0;
  const zoom = clampFollowZoom(state.followZoom != null ? state.followZoom : (state.trackMinZoom || 0) + 3);
  state.followZoom = zoom;
  const pos = state.lastSample;
  if (pos) state.map.setView([pos.lat, pos.lon], zoom, { animate: false });
  else state.map.setZoom(zoom);
}

/* Recenter (and re-derive the marker bearing, for heading-up) on the car's
 * interpolated position - called once per frame from updateDisplay via the
 * rAF loop, and again from updateDisplay on 'seeked'/'timeupdate' events so
 * a paused, scrubbed camera still lands on the right spot. No-op in Free. */
const CAMERA_THROTTLE_MS = 1000 / 24;
let lastCameraUpdateMs = 0;
function updateCamera(dot) {
  if (!state.map) return;
  if (state.cameraMode !== "follow-north" && state.cameraMode !== "follow-heading") return;
  if (!dot) return;
  // setView/setBearing force Leaflet to reposition every tile/pane, which is
  // too expensive to do on every rAF (60fps) without stealing frames from
  // video decode. Throttling here (but never while paused, so a scrub/seek
  // still lands the camera immediately) keeps the pan/rotate visually smooth
  // at a fraction of the cost.
  const now = performance.now();
  if (!video.paused && now - lastCameraUpdateMs < CAMERA_THROTTLE_MS) return;
  lastCameraUpdateMs = now;
  if (state.cameraMode === "follow-heading" && state.rotateAvailable) {
    // Sign convention: L.Map#setBearing(deg) rotates the map's content
    // clockwise by `deg` (it feeds straight into a CSS `rotate(deg)` on the
    // rotate pane - see leaflet-rotate's L.DomUtil.setTransform override).
    // To make the car's direction of travel point "up" (car-nav style), the
    // whole map must be rotated by the *negative* of the compass heading:
    // a feature at screen-angle `heading` clockwise-from-up needs to land at
    // 0 (straight up), and rotating the content clockwise by `bearing` moves
    // it to `heading + bearing`, so `bearing = -heading`.
    state.map.setBearing(-dot.heading);
    state.currentBearingDeg = -dot.heading;
  } else {
    state.currentBearingDeg = 0;
  }
  // animate:false - this runs every frame, so any easing would fight itself.
  state.map.setView([dot.lat, dot.lon], state.map.getZoom(), { animate: false });
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

/* ================= map / GPS track (Leaflet) =================
 * A real Leaflet map replaces the old hand-rolled canvas projection. Three
 * base layers are available ("None" = dark background only, fully offline;
 * "Map" = OpenStreetMap; "Satellite" = Esri World Imagery), all vendored
 * locally except the tile *images* themselves, which are fetched online only
 * when a tile layer is selected - "None" never makes a network request and
 * all overlays (track, lines, markers) keep working with no connectivity. */
const TRACK_COLOR = "#8fffb0";
const HOVER_COLOR = "#e8ebee";

function tileLayerFor(style) {
  if (style === "map") {
    return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    });
  }
  if (style === "satellite") {
    return L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    });
  }
  return null; // "none" - no network tiles, just the dark background + overlays
}

function applyMapStyle(style) {
  state.mapStyle = style;
  try { localStorage.setItem("rnv-map-style", style); } catch (err) { /* storage unavailable - not persisted, still works */ }
  if (state.activeTileLayer) { state.map.removeLayer(state.activeTileLayer); state.activeTileLayer = null; }
  const container = state.map.getContainer();
  container.classList.remove("basemap-none", "basemap-map", "basemap-satellite");
  container.classList.add("basemap-" + style);
  const layer = tileLayerFor(style);
  state.attributionControl.remove();
  if (layer) {
    // If tiles fail (offline), Leaflet just leaves them blank - the dark
    // container background and all overlays remain fully visible/functional.
    layer.on("tileerror", () => {});
    layer.addTo(state.map);
    state.activeTileLayer = layer;
    state.attributionControl.addTo(state.map);
  }
  updateMapToggleButtons();
}

/* Called once per session load (not per lap) once both the reference lap's
 * telemetry and the track geometry are available: fits the whole track with
 * a little padding, then clamps min zoom / pan bounds to that same padded
 * box so the user can zoom into a corner but never zoom or pan out past the
 * full track - fully derived from data, nothing track-specific. */
function setupMapBounds(points) {
  if (!state.map || !points.length) return;
  const padded = L.latLngBounds(points).pad(0.12);
  state.map.setMaxBounds(null);
  state.map.setMinZoom(0);
  const zoom = state.map.getBoundsZoom(padded, false);
  state.map.options.maxBoundsViscosity = 1.0;
  state.map.setMinZoom(zoom);
  state.map.setMaxZoom(19);
  state.trackMinZoom = zoom;
  state.trackPaddedBounds = padded;
  if (state.followZoom == null) state.followZoom = clampFollowZoom(zoom + 3);
  // Applies whichever camera mode is currently selected (Free: fits+clamps
  // to `padded` as before; Follow: jumps to the follow-zoom on the car).
  applyCameraMode(state.cameraMode);
}
function collectBoundsPoints(tel) {
  const pts = tel.lat.map((la, i) => [la, tel.lon[i]]);
  if (state.track) for (const line of state.track.lines) for (const p of line.points) pts.push([p.lat, p.lon]);
  return pts;
}

/* Start/finish/sector lines + labels - independent of which lap is showing,
 * redrawn once whenever /api/track resolves. */
function drawTrackLines() {
  if (!state.map || !state.trackLinesLayer) return;
  state.trackLinesLayer.clearLayers();
  if (!state.track) return;
  for (const line of state.track.lines) {
    const latlngs = line.points.map((p) => [p.lat, p.lon]);
    if (latlngs.length < 2) continue;
    const isSector = line.kind === "sector";
    L.polyline(latlngs, {
      renderer: state.trackRenderer,
      color: isSector ? "#7f8994" : ACCENT,
      weight: isSector ? 2 : 3,
      opacity: isSector ? 0.6 : 0.95,
      interactive: false,
    }).addTo(state.trackLinesLayer);
    const mid = latlngs[Math.floor(latlngs.length / 2)];
    const icon = L.divIcon({
      className: "track-line-label" + (isSector ? " is-sector" : ""),
      html: line.label,
      iconSize: [26, 14],
      iconAnchor: [13, 22],
    });
    L.marker(mid, { icon, interactive: false, keyboard: false }).addTo(state.trackLinesLayer);
  }
}

/* The lap's own GPS polyline - redrawn whenever the active lap changes. */
function drawStaticTrack(tel) {
  if (!tel || !state.map) return;
  state.mapDrawnFor = tel.lapNumber;
  const latlngs = tel.lat.map((la, i) => [la, tel.lon[i]]);
  if (state.trackPolyline) state.trackLayer.removeLayer(state.trackPolyline);
  state.trackPolyline = L.polyline(latlngs, {
    renderer: state.trackRenderer,
    color: TRACK_COLOR,
    weight: 3,
    opacity: 0.9,
    lineJoin: "round",
    lineCap: "round",
    interactive: false,
  }).addTo(state.trackLayer);
  const avgLat = tel.lat.reduce((a, b) => a + b, 0) / tel.lat.length;
  state.mapCosLat = Math.cos(avgLat * Math.PI / 180);
}

/* Heading-rotated position marker, updated every frame from the rAF loop. */
function updatePositionMarker(dot) {
  state.lastSample = dot;
  if (!state.map || !state.positionMarker) return;
  if (!dot) { state.map.removeLayer(state.positionMarker); return; }
  if (!state.map.hasLayer(state.positionMarker)) state.positionMarker.addTo(state.trackLayer);
  state.positionMarker.setLatLng([dot.lat, dot.lon]);
  const el = state.positionMarker.getElement();
  const arrow = el && el.querySelector(".track-pos-arrow");
  // The marker lives in Leaflet's markerPane, which leaflet-rotate keeps
  // screen-aligned (unrotated) by design - only the underlying lat/lng ->
  // screen-point math accounts for map bearing, not the icon's own CSS
  // rotation. So the arrow's on-screen rotation has to add the current map
  // bearing back in by hand: screen rotation = heading + bearing. In
  // follow-heading mode bearing = -heading (see updateCamera), so this
  // always cancels to 0 - the triangle points straight up, as expected for
  // car-nav. In Free/follow-north, bearing is always 0, so this reduces to
  // the heading, unchanged from before this feature.
  if (arrow) arrow.style.transform = "rotate(" + ((dot.heading != null ? dot.heading : 0) + (state.currentBearingDeg || 0)) + "deg)";
}

function redrawHover() {
  if (!state.hoverMarker) return;
  if (state.mapHover) {
    state.hoverMarker.setLatLng([state.mapHover.lat, state.mapHover.lon]);
    state.hoverMarker.setStyle({ opacity: 0.6 });
  } else {
    state.hoverMarker.setStyle({ opacity: 0 });
  }
}

/* click / drag to seek on the map: a fixed pixel hit-radius around the lap's
 * own GPS points (like the old canvas version), converted through Leaflet's
 * latLngToContainerPoint so it works at any zoom level. A hit on mousedown
 * temporarily disables map panning so the drag seeks instead of panning;
 * anywhere else, normal Leaflet pan/zoom behavior is left untouched. */
const SEEK_HIT_PX = 26;
function nearestTrackPoint(containerPoint) {
  const tel = state.telemetryCache.get(state.mapDrawnFor);
  if (!tel || !state.map) return null;
  let bi = -1, bd = SEEK_HIT_PX * SEEK_HIT_PX;
  for (let i = 0; i < tel.lat.length; i++) {
    const p = state.map.latLngToContainerPoint([tel.lat[i], tel.lon[i]]);
    const d = (p.x - containerPoint.x) ** 2 + (p.y - containerPoint.y) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  if (bi < 0) return null;
  return { t: tel.t[bi], lat: tel.lat[bi], lon: tel.lon[bi] };
}
let mapDragSeek = false;
function onMapMouseDown(e) {
  if (e.originalEvent.button) return;
  const hit = nearestTrackPoint(e.containerPoint);
  if (!hit) return;
  mapDragSeek = true;
  state.map.dragging.disable();
  video.currentTime = hit.t;
  state.mapHover = { lat: hit.lat, lon: hit.lon };
  redrawHover();
}
function onMapMouseMove(e) {
  if (mapDragSeek) {
    const hit = nearestTrackPoint(e.containerPoint);
    if (hit) { video.currentTime = hit.t; state.mapHover = { lat: hit.lat, lon: hit.lon }; redrawHover(); }
    return;
  }
  const hit = nearestTrackPoint(e.containerPoint);
  state.mapHover = hit ? { lat: hit.lat, lon: hit.lon } : null;
  redrawHover();
}
function onMapMouseUp() {
  if (mapDragSeek) {
    mapDragSeek = false;
    // Only restore dragging in Free - in either Follow mode dragging is
    // meant to stay off (the camera itself owns the view), so re-enabling
    // it here would let a drag fight the next recenter.
    if (state.cameraMode === "free") state.map.dragging.enable();
  }
}

function initMap() {
  let saved = "none";
  try { saved = localStorage.getItem("rnv-map-style") || "none"; } catch (err) { /* ignore */ }
  let savedCamera = "free";
  try { savedCamera = localStorage.getItem("rnv-camera-mode") || "free"; } catch (err) { /* ignore */ }

  state.map = L.map("track-map", {
    center: [0, 0],
    zoom: 2,
    zoomControl: false,          // scroll/pinch/double-click zoom stay enabled
    attributionControl: false,   // added back only when a tile layer is active
    preferCanvas: true,
    minZoom: 0,
    maxZoom: 19,
    // leaflet-rotate options - harmless no-ops if the plugin failed to load
    // (core Leaflet just stores unknown options and ignores them).
    rotate: true,
    touchRotate: false,
    rotateControl: false,
  });
  // Only present if leaflet-rotate patched L.Map with it - guards the
  // heading-up mode everywhere it's used, so a missing/broken vendor file
  // degrades to Free + follow-north instead of throwing.
  state.rotateAvailable = typeof state.map.setBearing === "function";
  state.cameraMode = savedCamera === "follow-heading" && !state.rotateAvailable ? "follow-north" : savedCamera;
  state.attributionControl = L.control.attribution({ position: "bottomright", prefix: false });
  state.trackRenderer = L.canvas({ padding: 0.5 });
  state.trackLinesLayer = L.layerGroup().addTo(state.map);
  state.trackLayer = L.layerGroup().addTo(state.map);
  state.hoverMarker = L.circleMarker([0, 0], {
    renderer: state.trackRenderer, radius: 7, color: HOVER_COLOR, weight: 1.5,
    opacity: 0, fillOpacity: 0, interactive: false,
  }).addTo(state.trackLayer);
  state.positionMarker = L.marker([0, 0], {
    icon: L.divIcon({ className: "track-pos-marker", html: '<div class="track-pos-arrow"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    interactive: false, keyboard: false,
  });

  applyMapStyle(saved);

  state.map.on("mousedown", onMapMouseDown);
  state.map.on("mousemove", onMapMouseMove);
  state.map.on("mouseup", onMapMouseUp);
  state.map.getContainer().addEventListener("mouseleave", () => {
    if (!mapDragSeek) { state.mapHover = null; redrawHover(); }
  });
  // In follow modes, dragging is off so wheel/pinch zoom is the only way the
  // view can move - re-center on the car immediately after so zoom always
  // reads as "zoom around the car", and remember the chosen zoom so the next
  // updateCamera() frame (and any later re-entry into a follow mode) keeps it.
  state.map.on("zoomend", () => {
    if (state.cameraMode === "free") return;
    state.followZoom = state.map.getZoom();
    if (state.lastSample) state.map.panTo([state.lastSample.lat, state.lastSample.lon], { animate: false });
  });
}

/* ================= G-ball =================
 * Parameterized over ctx/size so the same routine can render either the
 * always-on telemetry-panel canvas (116x116, with axis labels) or the
 * smaller fullscreen HUD canvas (variable size, rings + dot only - see
 * layoutFullscreenGball). All proportions below are derived from the size
 * so both targets keep the same visual ratios as the original 116px design. */
function drawGBall(ctx, W, H, latG, lonG, showLabels) {
  if (showLabels == null) showLabels = true;
  if (!W || !H) return;
  const dpr = state.dpr || 1; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, margin = W * (11 / 116), rMax = W / 2 - margin, MAXG = 2, scale = rMax / MAXG;
  ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx - rMax, cy); ctx.lineTo(cx + rMax, cy); ctx.moveTo(cx, cy - rMax); ctx.lineTo(cx, cy + rMax); ctx.stroke();
  for (const g of [0.5, 1, 1.5]) { ctx.strokeStyle = g === 1 ? "#343a42" : GRID; ctx.beginPath(); ctx.arc(cx, cy, g * scale, 0, 7); ctx.stroke(); }
  if (showLabels) {
    ctx.fillStyle = AXIS_TEXT; ctx.font = Math.round(W * (9 / 116)) + "px ui-monospace, monospace"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    for (const g of [1, 1.5]) ctx.fillText(g.toFixed(1), cx + 3, cy - g * scale - 1);
  }
  if (latG == null) return;
  const gx = clamp(latG, -MAXG, MAXG), gy = clamp(lonG, -MAXG, MAXG), px = cx + gx * scale, py = cy - gy * scale;
  const rOuter = W * (7 / 116), rInner = W * (5 / 116);
  ctx.beginPath(); ctx.arc(px, py, rOuter, 0, 7); ctx.fillStyle = "#131619"; ctx.fill();
  ctx.beginPath(); ctx.arc(px, py, rInner, 0, 7); ctx.fillStyle = ACCENT; ctx.fill();
}

/* Displayed video content rect (letterbox/pillarbox-aware), in videoWrap's
 * own coordinate space - .hud has inset:0 over videoWrap, so these numbers
 * double as the HUD's own coordinate space. Falls back to the full
 * container box before video metadata has loaded. */
function computeVideoContentRect() {
  const cw = videoWrap.clientWidth, ch = videoWrap.clientHeight;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!cw || !ch || !vw || !vh) return { x: 0, y: 0, width: cw, height: ch };
  const containerAspect = cw / ch, videoAspect = vw / vh;
  let dispW, dispH;
  if (videoAspect > containerAspect) { dispW = cw; dispH = cw / videoAspect; }
  else { dispH = ch; dispW = ch * videoAspect; }
  return { x: (cw - dispW) / 2, y: (ch - dispH) / 2, width: dispW, height: dispH };
}

/* Placement of the fullscreen friction circle, measured from the RingTaxi
 * footage's own burned-in overlay bar: centered at ~70% width / ~86% height
 * of the *video content* (not the container), sized to ~17% of the video
 * content height - this lands it in the gap between the burned-in
 * "RingTaxi.de" logo and the burned-in track-map/speed readout, without
 * covering either. Recomputed in layout() (covers resize/fullscreenchange)
 * and again once video metadata (videoWidth/videoHeight) becomes available. */
const FS_GBALL_CX = 0.70, FS_GBALL_CY = 0.86, FS_GBALL_SIZE_FRAC = 0.17;
function layoutFullscreenGball() {
  const rect = computeVideoContentRect();
  const size = Math.max(40, Math.round(rect.height * FS_GBALL_SIZE_FRAC));
  const cx = rect.x + rect.width * FS_GBALL_CX;
  const cy = rect.y + rect.height * FS_GBALL_CY;
  state.fsGballSize = size;
  fsGballWrap.style.width = size + "px";
  fsGballWrap.style.height = size + "px";
  fsGballWrap.style.left = Math.round(cx - size / 2) + "px";
  fsGballWrap.style.top = Math.round(cy - size / 2) + "px";
  const dpr = state.dpr || window.devicePixelRatio || 1;
  fsGballCanvas.width = Math.round(size * dpr);
  fsGballCanvas.height = Math.round(size * dpr);
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
  else if (e.code === "KeyF") { toggleFullscreen(); }
});

/* ================= fullscreen =================
 * Fullscreen is requested on .video-pane (video + HUD + transport bar), not
 * on the bare <video>, so our own HUD overlay and controls stay visible
 * instead of the browser's native fullscreen video UI. The map/charts/rail
 * simply aren't inside that element, so they're not shown - no extra hiding
 * logic needed; their update loops keep running harmlessly in the background. */
const videoPane = document.querySelector(".video-pane");
const videoWrap = document.querySelector(".video-wrap");
const fsBtn = $("fs-btn"), fsIcon = $("fs-icon");
const FS_ICON_EXPAND = '<path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9"></path>';
const FS_ICON_COMPRESS = '<path d="M5 1v4H1M9 1v4h4M13 9h-4v4M1 9h4v4"></path>';

function fullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
function isPaneFullscreen() { return fullscreenElement() === videoPane; }
function requestPaneFullscreen() {
  if (videoPane.requestFullscreen) videoPane.requestFullscreen().catch(() => {});
  else if (videoPane.webkitRequestFullscreen) videoPane.webkitRequestFullscreen();
}
function exitPaneFullscreen() {
  if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
  else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
}
function toggleFullscreen() { if (isPaneFullscreen()) exitPaneFullscreen(); else requestPaneFullscreen(); }
function syncFullscreenButton() {
  const active = isPaneFullscreen();
  fsBtn.classList.toggle("is-active", active);
  fsIcon.innerHTML = active ? FS_ICON_COMPRESS : FS_ICON_EXPAND;
  fsBtn.title = active ? "Exit fullscreen (Esc)" : "Fullscreen (F)";
}
// Esc (or any other exit path) fires this natively - never assume state,
// always read it back from the document and re-run layout so the map/charts
// (hidden, not destroyed, during fullscreen) re-measure correctly.
function onFullscreenChange() { syncFullscreenButton(); requestAnimationFrame(layout); }
document.addEventListener("fullscreenchange", onFullscreenChange);
document.addEventListener("webkitfullscreenchange", onFullscreenChange);
fsBtn.addEventListener("click", toggleFullscreen);
videoWrap.addEventListener("dblclick", toggleFullscreen);

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
  if (!tel) {
    hud.speed.textContent = "—"; altValueEl.textContent = "—"; drawGBall(gctx, 116, 116, null, null);
    if (isPaneFullscreen() && state.fsGballSize) drawGBall(fsGctx, state.fsGballSize, state.fsGballSize, null, null, false);
    updateScrub(); return;
  }
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
    const name = state.mapCosLat != null ? nearestCorner(s.lat, s.lon, state.mapCosLat) : "";
    hud.corner.textContent = name || "—"; hud.corner.classList.toggle("is-dim", !name);
    mapCornerEl.textContent = name || "—";
    // throttle / brake (derived from longitudinal G)
    if (s.lonG >= 0) { hud.throttle.style.width = (Math.min(1, s.lonG / 1.0) * 50) + "%"; hud.brake.style.width = "0%"; }
    else { hud.brake.style.width = (Math.min(1, -s.lonG / 1.2) * 50) + "%"; hud.throttle.style.width = "0%"; }
    drawGBall(gctx, 116, 116, s.latG, s.lonG);
    if (isPaneFullscreen() && state.fsGballSize) drawGBall(fsGctx, state.fsGballSize, state.fsGballSize, s.latG, s.lonG, false);
    updateCamera(s);
    updatePositionMarker(s);
  }
  renderCharts(t);
  updateScrub();
}
function rafLoop() { updateDisplay(); state.rafId = video.paused ? null : requestAnimationFrame(rafLoop); }
video.addEventListener("timeupdate", updateDisplay);
video.addEventListener("seeked", updateDisplay);
video.addEventListener("loadedmetadata", () => { buildScrubTicks(); updateScrub(); layoutFullscreenGball(); });
video.addEventListener("durationchange", buildScrubTicks);

/* ================= layout / sizing ================= */
function layout() {
  const dpr = window.devicePixelRatio || 1; state.dpr = dpr;
  gballCanvas.width = Math.round(116 * dpr); gballCanvas.height = Math.round(116 * dpr);
  layoutFullscreenGball();
  if (state.map) {
    state.map.invalidateSize();
    if (state.cameraMode !== "free" && state.lastSample) {
      state.map.setView([state.lastSample.lat, state.lastSample.lon], state.map.getZoom(), { animate: false });
    }
  }
  if (state.pendingBoundsPoints) { setupMapBounds(state.pendingBoundsPoints); state.pendingBoundsPoints = null; }
  const active = state.activeLapNumber;
  const tel = active != null ? state.telemetryCache.get(active) : null;
  if (tel) buildCharts(tel, state.laps.find((l) => l.lapNumber === active));
  updateDisplay();
}
let roRaf = null;
const ro = new ResizeObserver(() => { if (roRaf) return; roRaf = requestAnimationFrame(() => { roRaf = null; layout(); }); });
ro.observe($("track-map").parentElement); ro.observe($("chart-speed"));

/* ================= startup / session loading ================= */
async function loadTrack() {
  try {
    const res = await fetch("/api/track"); if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    data.curves = data.curves.map((c) => Object.assign({}, c, { name: stripCurve(c.description) }));
    state.track = data;
    drawTrackLines();
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
  state.mapCosLat = null;
  state.mapHover = null;
  state.pendingBoundsPoints = null;
  state.trackMinZoom = null;
  state.trackPaddedBounds = null;
  state.followZoom = null;
  state.currentBearingDeg = 0;
  if (state.trackPolyline) { state.trackLayer.removeLayer(state.trackPolyline); state.trackPolyline = null; }
  if (state.trackLinesLayer) state.trackLinesLayer.clearLayers();
  if (state.hoverMarker) state.hoverMarker.setStyle({ opacity: 0, fillOpacity: 0 });
  if (state.map && state.positionMarker) state.map.removeLayer(state.positionMarker);
  if (state.map) {
    state.map.setMaxBounds(null);
    state.map.setMinZoom(0);
    state.map.dragging.enable();
    if (state.rotateAvailable) state.map.setBearing(0);
  }
  pillsEl.innerHTML = "";
  state.pillEls = [];
  $("session-date").textContent = "—";
  $("kpi-top").textContent = "—";
  $("kpi-maxg").textContent = "—";
}

/* Loads laps + track for whichever session the server currently has active
 * (called once at startup, and again every time a new session is selected).
 * Once both the reference lap's telemetry and the track geometry are in,
 * the map is fitted/clamped to the track bounds (see setupMapBounds). */
async function loadSessionData() {
  try {
    const res = await fetch("/api/laps"); if (!res.ok) throw new Error("HTTP " + res.status);
    state.laps = await res.json();
    buildPills(); refreshSessionDate();
    const trackPromise = loadTrack();
    const full = state.laps.find((l) => l.isFullLap) || state.laps[0];
    let tel = null;
    if (full) { tel = await ensureTelemetry(full.lapNumber); if (tel && state.activeLapNumber == null) { state.activeLapNumber = full.lapNumber; highlightPill(full.lapNumber); refreshKpis(); } }
    await trackPromise;
    if (tel) state.pendingBoundsPoints = collectBoundsPoints(tel);
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
  initMap(); buildMapToggle(); buildCameraToggle(); buildRates();
  drawGBall(gctx, 116, 116, null, null);
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
