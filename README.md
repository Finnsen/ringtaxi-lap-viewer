# RingTaxi Onboard Player

Local, offline video player for onboard footage from Nürburgring RingTaxi, with
synchronized telemetry (speed, altitude, GPS track) pulled from the vehicle's
RaceNavigator logs.

## Getting started

Requires only the Python 3.12 standard library — no `pip install` needed
(an optional `imageio-ffmpeg` package is used as an automatic fallback if
`ffmpeg` isn't installed — see "Automatic video preparation" below).

```bash
python3 server.py            # starts on http://localhost:8000
python3 server.py --port 8765
```

> **Note (WSL2):** If the browser shows "The requested resource has not been
> defined / NT-ware MOM HTTP Server", port 8000 is already taken by a print
> service on the Windows side. Start the server on a different port, e.g.
> `--port 8765`.

Open <http://localhost:8000> in your browser. Video, telemetry and the UI
(including [Leaflet](https://leafletjs.com/), vendored locally — see "Real
map background" below) are served locally with no CDN dependencies; the app
is fully functional with no internet connection. The only optional
network requests are the OpenStreetMap/satellite map tiles, and only if you
explicitly switch the GPS map's layer to "Map" or "Satellite" — the default
"None" layer never leaves your machine.

If `./media` contains a recording, it's loaded automatically on startup, same
as before. Otherwise (or to switch to a different recording) a folder-picker
modal lets you browse the filesystem — including USB sticks and other
attached disks — and pick a folder to load a session from. The folder you
pick is never written to; it's treated as strictly read-only (it might be a
USB stick). See "Folder picker and sessions" below.

Files/folders the server may read from (all read-only, never written to):

- `media/*.rnz` or `<your folder>/*.rnz` — lap data (zipped XML), parsed in
  memory when a session is loaded.
- `media/*.mkv` or `<your folder>/*.mkv` — the original camera recording,
  used as the remux source (and, without `ffmpeg`, played directly).

The only things this server writes to are `derived/` (its own remux cache)
and `.rnv-state.json` in the project directory (remembers the last folder
used, for the folder picker — excluded from Git).

### First-time setup

After a fresh clone, `media/` and `derived/` don't exist yet (both are
excluded from Git — large files / personal recordings). Copy the original
files from your camera/USB stick into `media/` (or point the folder picker
at wherever they already live — no copying required in that case) and start
the server; see "Automatic video preparation" for how the browser-friendly
video gets created.

If you'd rather do it by hand, this is a lossless repackaging (stream copy,
no re-encoding, takes seconds):

```bash
mkdir -p derived
ffmpeg -i media/20260703_095104957_RNONE-1126.mkv -c copy \
  -movflags +faststart derived/20260703_095104957_RNONE-1126.mp4
```

If you don't have `ffmpeg` (and no sudo), you can fetch a static binary via
pip:

```bash
pip install --user imageio-ffmpeg   # add --break-system-packages if needed
python3 -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"
```

and use the path it prints instead of `ffmpeg` in the command above.
(Warnings about "Non-monotonic DTS" on the audio track are harmless — ~0.5 ms
jitter from the GStreamer muxer in the recording hardware.)

### Folder picker and sessions

A folder can contain more than one recording. The server groups the `.mkv` +
`.rnz` files in a folder into **sessions** by following the authoritative
link inside each `.rnz` file's XML (`<videos><video><fileName>`) — not just
the timestamp in the filename. If a folder has several sessions, the folder
picker lists all of them (video file name, date/time, lap count) so you can
choose which one to load.

The picker shows convenient shortcuts (home folder, filesystem root, and any
mounted disks — on WSL2, USB sticks and Windows drives usually appear under
`/mnt/*`), plus normal folder navigation with breadcrumbs. The last folder
you used is remembered in `.rnv-state.json` (in the project directory,
machine-specific, excluded from Git) and preselected the next time you open
the picker. Click "Change folder" in the header at any time to switch to a
different recording.

### Automatic video preparation

When you select a session, the server looks for a browser-friendly video in
this order:

1. **A cached remux** in `derived/<video-name>.mp4` — used immediately if
   present (this is what makes the bundled `media/` example start instantly).
2. **An automatic remux**, if `ffmpeg` is available (found via `PATH`, or via
   the `imageio-ffmpeg` package as a fallback): the server transcodes the
   `.mkv` into `derived/<video-name>.mp4` in a background thread (lossless
   stream copy, `-c copy -movflags +faststart`, no quality loss, no
   re-encoding). The UI shows a "Preparing video…" progress indicator while
   this runs; once done, the mp4 is cached in `derived/` so future loads of
   the same session are instant.
3. **The raw `.mkv`, served directly**, if no `ffmpeg` is available anywhere.
   A notice in the UI explains that playback and seeking then depend on your
   browser (Chrome usually plays H.264/AAC MKV directly; Firefox and Safari
   often don't).

## File formats (short version)

- `media/*.idx` — two lines of text `epochMillis;YYYY-MM-DD HH:MM:SS.mmm`
  giving the video's start/end wall-clock time. Used only as a cross-check;
  the XML below contains the same information and is what's actually used.
- `media/*.rnz` — each file is effectively a ZIP containing a single `.rn`
  file: XML from RaceNavigator (macrix.eu), root element `<lapData>`.
  Relevant parts:
  - `<lap>`: lap number, start/end time (wall-clock), plus
    `isStartLineCrossed`/`isEndLineCrossed`. Both = 1 means a completed,
    genuine lap. Here: Lap 1 (1.474 s) and Lap 3 (2.296 s) are the in-lap and
    out-lap respectively (flag = 0), Lap 2 (7:21.330) is the full lap.
  - `<videos><video>`: `<fileName>` + `<startTime>` which is the video's
    wall-clock time for t = 0. Video offset for a lap is computed as
    `videoOffsetSeconds = lap.startTime − video.startTime` (clamped to 0 for
    negative values — Lap 1 starts 1.447 s before the video recording
    begins).
  - `<lapSectors>`: sector times for the full lap (4 sectors for Lap 2),
    converted to offset/duration relative to video-t0 the same way.
  - `<measurements><sm .../>`: roughly 10 Hz position/speed log for the lap.
    Attributes used here: `mt` (timestamp), `lt`/`lg` (latitude/longitude),
    `al` (altitude, above sea level), `ds` (cumulative distance), `gs`
    (speed), `la`/`lo` (lateral/longitudinal acceleration), `igpsv` (validity
    flag for the GPS sample).

### Empirical findings on `gs` and `igpsv`

**`gs` (speed) is in mm/s.** For Lap 2 (Bridge-to-Gantry, roughly 18.9 km in
441.2 s actual duration), two independent calculations agree:

- `avg(gs)` over the lap = 42,889 → interpreted as mm/s = 42.89 m/s =
  **154.4 km/h**
- `(ds_last − ds_first) / duration` = 18,909,405 mm / 441.2 s = 42.86 m/s =
  **154.3 km/h**

The discrepancy between the two methods is under 0.1 km/h, which doesn't
coincide with any other plausible scale (m/h, cm/s, etc. give completely
unreasonable average speeds for a 7:21 lap time over ~19 km). Conclusion:
`speedKmh = gs * 0.0036` (mm/s → km/h).

**`igpsv` = 1 means a valid sample, `igpsv` = 0 marks a duplicated/stationary
sample.** Of 4421 samples in Lap 2, 4413 have `igpsv = 1`. The 8 with
`igpsv = 0` are all exact duplicates of the previous sample (same `mt`, `lt`,
`lg`, `ds`) — i.e. a moment with no new GPS fix where the logger repeats the
previous position instead of skipping the row. The server filters these out
(`igpsv != 1`) before telemetry is sent to the client, so the GPS track and
speed graph don't show artificial "stops".

### Empirical findings on `za` and `dr`

**`za` (vertical acceleration) is in milli-g, gravity-compensated.** For
Lap 2 the raw data ranges from −910 to +1456, averaging around +30 — i.e.
centered near 0 g as expected when gravity has already been subtracted, with
excursions from bump/curb noise and terrain profile. Same processing as
`la`/`lo`: centered moving average over 5 samples before downsampling,
`/1000` → g (smoothed Lap 2: roughly −0.5…+1.0 g).

**`dr` is the heading in compass degrees, 0–360.** Used to draw the
direction arrow on the map; interpolated between measurement points along
the shortest path across the 0/360 wraparound (e.g. 350° → 10° gives 0°
halfway, not 180°).

### Empirical findings on `la` and `lo` (G-forces)

**`la` (lateral) and `lo` (longitudinal) acceleration are in milli-g.** For
Lap 2 the raw data ranges from −2523 to +1618 for `la` and from −1313 to
+815 for `lo`. Interpreted as milli-g this gives roughly −1.3 g under
braking and +0.8 g under acceleration for `lo` — entirely plausible values
for a fast road car, where the negative sign with the largest magnitude
unambiguously corresponds to braking (negative `lo` = braking). For `la`,
the extreme values around −2.5 g are brief spikes from curb strikes/sensor
noise; the sign direction (left vs. right) hasn't been verified, so the axis
is labeled only ±g. The server smooths both channels with a centered moving
average over 5 samples (~0.5 s at 10 Hz) before downsampling, so the API
serves clean data (smoothed Lap 2: lateral roughly −2.0…+1.5 g, longitudinal
roughly −1.1…+0.5 g).

## API

- `GET /api/laps` — list of laps: `lapNumber`, `label`, start/end time,
  `durationSeconds`, `videoOffsetSeconds`, `isFullLap`, sectors and video
  file name.
- `GET /api/telemetry/<lapNumber>` — `t` (seconds relative to video-t0),
  `speedKmh`, `lat`, `lon`, `alt`, `latG`, `lonG`, `vertG`, `heading` —
  downsampled to ~5 Hz, invalid (`igpsv = 0`) samples filtered out.
  `latG`/`lonG`/`vertG` are in g (smoothed server-side, 3 decimals); negative
  `lonG` = braking. `heading` is the direction of travel in compass degrees
  (0–360, from `dr`), not smoothed.
- `GET /api/track` — track geometry, parsed once at startup from
  `<trackVariant><trackDataXml><definition>` in the full lap's XML (all lap
  files in a session embed the same definition, so in principle any `.rnz`
  file could have been used): `lines` (start, finish and the 3 sector lines,
  each with `kind`, `label` and 3 reference points) and `curves` (83 named
  Nürburgring corners, each with `description` and 8 reference points
  tracing the corner).
- `GET /api/browse?path=<dir>` — folder-picker listing: resolved `path`,
  `parent`, `dirs` (subdirectory names, hidden/unreadable ones skipped),
  `sessions` (same shape as `/api/sessions` below, for this folder), and
  `roots` (shortcut folders: home, filesystem root, mounted disks under
  `/mnt/*`). `path` defaults to the last-used folder (or the home folder) if
  omitted. Returns a JSON `error` with a 4xx status for a nonexistent path,
  a path that isn't a directory, or a permission error.
- `GET /api/sessions?path=<dir>` — sessions found directly in `<dir>`: each
  has `id`, `videoFileName`, `dateTime`, `lapCount`, `laps` (lap
  number/duration/isFullLap), `hasVideoFile` and `hasCachedVideo`.
- `POST /api/session` (JSON body `{"dir": ..., "id": ...}`, or `GET
  /api/session?dir=...&id=...`) — loads that session's laps/track into the
  server, resolves/starts preparing its video, and returns the same payload
  as `/api/session/status`.
- `GET /api/session/status` (alias: `/api/session/current`) — the active
  session's state: `active`, `dir`, `sessionId`, `videoFileName`,
  `videoUrl`, `status` (`none` | `ready` | `remuxing` | `raw` | `error`),
  `percent` (remux progress, if derivable) and `message`.
- `GET /video/<name>` — the active session's video: `<name>.mp4` is served
  from `derived/`, `<name>.mkv` is served from the active session's own
  folder (raw fallback with no `ffmpeg`) — resolved and checked to stay
  within one of those two folders. Full Range support (206/Content-Range/
  Accept-Ranges) for browser seeking either way.
- `GET /` — static UI (`static/`).

## User interface

On first load with no active session, a folder-picker modal opens
automatically (see "Folder picker and sessions" above); a "Change folder"
button in the header reopens it at any time. While a video is being prepared
(automatic remux) or a fallback notice applies (no `ffmpeg`, raw `.mkv`
playback), an overlay on the video pane communicates the current state.

Video on the left, lap list on the right (click a lap to jump to the
corresponding point in the video and start playback — the active lap is
marked automatically during playback). Below the video is a telemetry panel
with a large speed readout, altitude, the name of the nearest Nürburgring
corner, and a GPS map with a direction arrow for the current position
(interpolated between measurement points, rotated to match the heading).

### Fullscreen mode

The video pane (video + HUD + transport controls) can go fullscreen via the
fullscreen button in the transport bar, double-clicking the video, or the `F`
key (ignored while typing in a text field). The HUD — speed, corner name,
timecode, throttle/brake bar — stays visible and scales up slightly; the map,
charts and lap list are simply outside the fullscreened element, so they're
not shown but keep updating in the background. Press Esc (or the button
again) to exit; the map and charts re-measure themselves automatically once
back in the normal layout.

### Track lines and corner names on the map

The start/finish line and the 3 sector lines (from `/api/track`) are drawn
as short cross-lines over the track: start/finish in accent color with the
labels "S"/"F", sector lines muted with the labels "S1"–"S3". During
playback, the name of the nearest of the track's 83 named corners (e.g.
"Antoniusbuche") is shown below the speed readout when the car is within
roughly 60 m of the corner; otherwise a muted dash is shown.

### Click-to-seek on the GPS map

Click (or drag) anywhere near the GPS track to jump to that point in the
video: the nearest telemetry point within a fixed pixel hit-radius is
looked up (converted through the map's current zoom/pan via
`latLngToContainerPoint`, so it works the same at any zoom level), and the
video seeks to that point's timestamp. A hit disables map panning for the
duration of the drag so it seeks instead of panning the map; clicking or
dragging elsewhere on the map behaves like a normal map (pan/zoom). While
hovering over the track, a faint ring marker is shown at the nearest point.

### Real map background (optional, OpenStreetMap / satellite)

The GPS map is a [Leaflet](https://leafletjs.com/) map (vendored locally in
`static/vendor/leaflet/` — no CDN, so the app keeps working fully offline).
A small layer control in the top-right corner of the map switches between:

- **None** (default) — no tiles, just the dark background with the track
  polyline, start/finish/sector lines and markers. Makes no network
  requests at all — this is what you get with no internet connection.
- **Map** — standard OpenStreetMap tiles, dimmed/desaturated with a CSS
  filter so the light tiles don't clash with the dark cockpit UI.
- **Satellite** — Esri World Imagery aerial tiles.

Both online layers are fetched on demand only when selected, require
attribution (shown unobtrusively in the map's bottom-right corner, hidden
for "None"), and are used only for orientation — track lines, corner
names, click-to-seek and the position marker are all computed from the
session's own GPS telemetry and `/api/track` geometry, independent of
whether a base map is loaded. If tiles fail to load (offline), Leaflet just
leaves them blank; the dark background and every overlay stay fully
functional. The chosen layer is remembered in `localStorage`.

Zoom is constrained to the track: after a session loads, the map fits the
whole track (from the active lap's telemetry plus the track's start/finish/
sector line points) with a little padding, then that padded area becomes
both the minimum zoom level and the pan boundary (`maxBounds`) — so you can
zoom in to inspect a corner, but can't zoom or pan out past the full track.
This is derived purely from the loaded session's coordinates, so it works
the same at any track, not just Nürburgring.

### Camera modes (free / follow / heading-up)

A second button group under the base-layer toggle switches between three
camera behaviors:

- **Free** (default) — the behavior above: fit to the whole track, pan/zoom
  manually, clamped to the track's bounds.
- **Follow** — the map recenters on the car every frame during playback
  (north stays up), at an adjustable zoom (defaults a few levels in from the
  track-fit zoom). Manual panning is disabled — dragging the map won't fight
  the camera — but you can still zoom with the scroll wheel/pinch, and the
  camera re-centers on the car immediately after. The track's `maxBounds`
  clamp is relaxed in this mode (it would otherwise fight centering near the
  edge of the track at high zoom) but the minimum zoom stays the same.
- **Nav** (heading-up) — like Follow, but the map also rotates so the car's
  current direction of travel always points up, car-navigation style. This
  uses the [leaflet-rotate](https://github.com/Raruto/leaflet-rotate) plugin
  (vendored locally, version **0.2.8**, in
  `static/vendor/leaflet-rotate/leaflet-rotate.js` — no CDN, loaded after
  `leaflet.js` and before `app.js`). If the plugin fails to load for any
  reason, the "Nav" option is hidden automatically and the app falls back to
  Free/Follow (north-up) only — nothing else breaks.

The selected mode is remembered in `localStorage`, alongside the base-layer
choice. Switching from Follow/Nav back to Free resets the map's rotation and
refits the whole track; switching from Free into a follow mode jumps
straight to the follow zoom on the car's current position. Clicking/dragging
the track to seek still works in every mode.

### Chart panel

Below the telemetry panel are three time-series charts for the active lap,
sharing a common time axis: speed (km/h), altitude (above sea level), and
G-forces (lateral, longitudinal and vertical as three lines). A playhead
line follows video playback, and the current value is shown in the chart's
label row. Click or drag in a chart to seek the video; hovering shows a
synchronized crosshair with values across the charts. For full laps, sector
boundaries are drawn as discrete vertical grid lines. Everything is drawn
with plain canvas — no charting libraries.

### G-ball (friction circle)

Next to the speed readout is a small friction circle with concentric rings
at 0.5 / 1.0 / 1.5 g and a dot that follows the current (latG, lonG) during
playback (throttle up, brake down; the display is clipped at ±2 g), plus
numeric readouts for both channels. The data is smoothed server-side (see
the section on `la`/`lo`) so curb spikes don't make the ball jump around.

No CDNs are used — the only third-party code is Leaflet (for the optional
map backgrounds) and its leaflet-rotate plugin (for heading-up follow mode),
both vendored locally under `static/vendor/`; the rest of the UI (charts,
HUD, G-ball, folder picker) is plain HTML/CSS/JS. The app runs fully offline
from `static/`, with map tiles as the sole optional online extra.
