#!/usr/bin/env python3
"""RingTaxi video player - local server.

The media folder and the session (an .mkv plus its .rnz lap files) are chosen
at runtime through a small folder-picker API (see below) instead of being
hardcoded. RaceNavigator XML is parsed in memory, without writing anything to
the selected media folder - it is always treated as read-only (it may live on
a USB stick). The only thing this server ever writes to is `derived/` (the
project's own remux cache) and `.rnv-state.json` (remembers the last folder
used, for the folder picker).

Standard library only - no external dependencies (an optional `imageio-ffmpeg`
package is used as a fallback if the `ffmpeg` binary isn't on PATH; the app
degrades gracefully if neither is available).
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

BASE_DIR = Path(__file__).resolve().parent
MEDIA_DIR = BASE_DIR / "media"
DERIVED_DIR = BASE_DIR / "derived"
STATIC_DIR = BASE_DIR / "static"
STATE_FILE = BASE_DIR / ".rnv-state.json"

NS = {"r": "http://macrix.eu/racenavigator/LapDataSchema"}

DATE_FMT = "%Y-%m-%d %H:%M:%S.%f"

# gs (speed measurement attribute) is empirically established to be mm/s.
# For Lap 2 (Bridge-to-Gantry, ~18.9 km in ~441.2 s), this gives:
#   avg(gs) = 42889 mm/s = 42.89 m/s = 154.4 km/h
#   (ds_last - ds_first) / duration = 18909405 mm / 441.2 s = 42.86 m/s = 154.3 km/h
# The two independent calculations agree within 0.1 km/h -> mm/s confirmed.
GS_TO_KMH = 0.0036  # mm/s -> km/h  (1 mm/s = 0.0036 km/h)

# la/lo (lateral/longitudinal acceleration) are in milli-g (empirically
# verified: Lap 2 raw data la -2523..+1618 mg, lo -1313..+815 mg -> interpreted
# as milli-g gives plausible -1.3 g braking / +0.8 g acceleration; the extreme
# lateral values are curb strikes/noise and are smoothed with a moving average
# before being served).
MILLI_G = 1000.0
SMOOTH_WINDOW = 5  # samples (~0.5 s at 10 Hz), centered moving average

# za (vertical acceleration) is in milli-g, gravity-compensated (empirically
# verified: Lap 2 raw data -910..+1456 mg, average around +30 mg - plausible
# for a car at rest/steady speed with bump noise from dips/curbs). Same
# processing as la/lo: centered moving average over 5 samples before
# downsampling, /1000 -> g.
# dr is heading in degrees, 0-360.


def moving_average(values: list[float], window: int) -> list[float]:
    """Centered moving average; the window shrinks symmetrically at the ends."""
    half = window // 2
    n = len(values)
    out = []
    for i in range(n):
        a = max(0, i - half)
        b = min(n, i + half + 1)
        out.append(sum(values[a:b]) / (b - a))
    return out


def parse_dt(s: str) -> datetime:
    return datetime.strptime(s.strip(), DATE_FMT)


class Lap:
    def __init__(self, lap_number: int, start_time: datetime, end_time: datetime,
                 is_start_crossed: bool, is_end_crossed: bool,
                 video_file_name: str, video_start_time: datetime,
                 sectors: list[dict], measurements_xml: list[ET.Element]):
        self.lap_number = lap_number
        self.start_time = start_time
        self.end_time = end_time
        self.is_start_crossed = is_start_crossed
        self.is_end_crossed = is_end_crossed
        self.video_file_name = video_file_name
        self.video_start_time = video_start_time
        self.sectors = sectors
        self.measurements_xml = measurements_xml

    @property
    def duration_seconds(self) -> float:
        return (self.end_time - self.start_time).total_seconds()

    @property
    def video_offset_seconds(self) -> float:
        offset = (self.start_time - self.video_start_time).total_seconds()
        return max(0.0, offset)

    @property
    def is_full_lap(self) -> bool:
        return self.is_start_crossed and self.is_end_crossed

    @property
    def label(self) -> str:
        if self.is_full_lap:
            return f"Lap {self.lap_number}"
        if self.lap_number == min_lap_number_hint.get("value", self.lap_number):
            return "In-lap"
        return "Out-lap"

    def to_json(self) -> dict:
        sector_json = []
        for sec in self.sectors:
            sec_offset = max(0.0, (sec["startTime"] - self.video_start_time).total_seconds())
            sec_duration = (sec["endTime"] - sec["startTime"]).total_seconds()
            sector_json.append({
                "sectorNumber": sec["sectorNumber"],
                "offsetSeconds": round(sec_offset, 3),
                "durationSeconds": round(sec_duration, 3),
            })
        return {
            "lapNumber": self.lap_number,
            "label": self.label,
            "startTime": self.start_time.strftime(DATE_FMT)[:-3],
            "endTime": self.end_time.strftime(DATE_FMT)[:-3],
            "durationSeconds": round(self.duration_seconds, 3),
            "videoOffsetSeconds": round(self.video_offset_seconds, 3),
            "isFullLap": self.is_full_lap,
            "isStartLineCrossed": self.is_start_crossed,
            "isEndLineCrossed": self.is_end_crossed,
            "sectors": sector_json,
            "videoFileName": self.video_file_name,
        }


# Used to determine whether an incomplete lap is an in-lap or out-lap
# (the one with the lowest lapNumber among incomplete laps is the in-lap).
# Scoped to whichever session is currently active (single-user local app).
min_lap_number_hint: dict = {}

LAPS: dict[int, Lap] = {}

# Track geometry (start/finish/sector lines + corner names) for the active
# session, parsed from <trackVariant><trackDataXml><definition> - all lap XML
# files in a session embed the same definition, but we prefer the full lap.
TRACK: dict = {}

# Guards LAPS/TRACK/CURRENT while a session switch is in progress.
SESSION_LOCK = threading.Lock()

# State of the currently active session (folder + video resolution/remux
# progress). See session_state_payload() for the shape exposed over the API.
CURRENT: dict = {}


def _ref_points(el: ET.Element | None) -> list[dict]:
    if el is None:
        return []
    points = []
    for rp in el.findall("r:referencePoints/r:referencePoint", NS):
        points.append({
            "lat": float(rp.get("latitude")),
            "lon": float(rp.get("longitude")),
        })
    return points


def parse_track_geometry(root: ET.Element) -> dict | None:
    definition = root.find(
        "r:trackVariant/r:trackDataXml/r:definition", NS
    )
    if definition is None:
        return None

    lines = []
    start_el = definition.find("r:startLine", NS)
    if start_el is not None:
        lines.append({"kind": "start", "label": "S", "points": _ref_points(start_el)})
    end_el = definition.find("r:endLine", NS)
    if end_el is not None:
        lines.append({"kind": "finish", "label": "F", "points": _ref_points(end_el)})
    sectors_el = definition.find("r:sectors", NS)
    if sectors_el is not None:
        for idx, sector_el in enumerate(sectors_el.findall("r:sector", NS), start=1):
            lines.append({
                "kind": "sector",
                "label": f"S{idx}",
                "points": _ref_points(sector_el),
            })

    curves = []
    curves_el = definition.find("r:curves", NS)
    if curves_el is not None:
        for curve_el in curves_el.findall("r:curve", NS):
            curves.append({
                "description": curve_el.get("description", ""),
                "points": _ref_points(curve_el),
            })

    return {"lines": lines, "curves": curves}


def parse_rnz(rnz_path: Path) -> tuple[Lap, dict | None]:
    """Parse a single .rnz (zipped RaceNavigator XML) file into a Lap plus
    the track geometry embedded in it (if any). Read-only: never writes."""
    with zipfile.ZipFile(rnz_path) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith(".rn")]
        if not names:
            raise ValueError("no .rn entry in archive")
        xml_bytes = zf.read(names[0])

    root = ET.fromstring(xml_bytes)
    lap_el = root.find("r:lap", NS)
    lap_number = int(lap_el.find("r:lapNumber", NS).text)
    start_time = parse_dt(lap_el.find("r:startTime", NS).text)
    end_time = parse_dt(lap_el.find("r:endTime", NS).text)
    is_start_crossed = lap_el.find("r:isStartLineCrossed", NS).text.strip() == "1"
    is_end_crossed = lap_el.find("r:isEndLineCrossed", NS).text.strip() == "1"

    geometry = parse_track_geometry(root)

    video_el = root.find("r:videos/r:video", NS)
    video_file_name = video_el.find("r:fileName", NS).text
    video_start_time = parse_dt(video_el.find("r:startTime", NS).text)

    sectors = []
    # Sector times are only meaningful for complete laps (in-laps/out-laps
    # tend to have empty or truncated sector start/end times).
    if is_start_crossed and is_end_crossed:
        lap_sectors_el = root.find("r:lapSectors", NS)
        if lap_sectors_el is not None:
            for sec_el in lap_sectors_el.findall("r:lapsector", NS):
                start_text = sec_el.find("r:startTime", NS).text
                end_text = sec_el.find("r:endTime", NS).text
                if not start_text or not end_text:
                    continue
                sectors.append({
                    "sectorNumber": int(sec_el.find("r:sectorNumber", NS).text),
                    "startTime": parse_dt(start_text),
                    "endTime": parse_dt(end_text),
                })

    measurements_el = root.find("r:measurements", NS)
    sm_elements = list(measurements_el.findall("r:sm", NS)) if measurements_el is not None else []

    lap = Lap(
        lap_number=lap_number,
        start_time=start_time,
        end_time=end_time,
        is_start_crossed=is_start_crossed,
        is_end_crossed=is_end_crossed,
        video_file_name=video_file_name,
        video_start_time=video_start_time,
        sectors=sectors,
        measurements_xml=sm_elements,
    )
    return lap, geometry


def scan_sessions(dir_path: Path) -> list[dict]:
    """Group the .rnz files directly inside dir_path into sessions: a session
    is one video (.mkv) plus all .rnz lap files that reference it via
    <videos><video><fileName> (the authoritative link - not just the
    filename timestamp pattern)."""
    groups: dict[str, list[Lap]] = {}
    for rnz_path in sorted(dir_path.glob("*.rnz")):
        try:
            lap, _geometry = parse_rnz(rnz_path)
        except Exception as exc:
            print(f"Warning: could not read {rnz_path.name}: {exc}", file=sys.stderr)
            continue
        groups.setdefault(lap.video_file_name, []).append(lap)

    sessions = []
    for video_name, laps in groups.items():
        laps.sort(key=lambda l: l.lap_number)
        stem = Path(video_name).stem
        video_path = dir_path / video_name
        sessions.append({
            "id": video_name,
            "videoFileName": video_name,
            "dateTime": laps[0].video_start_time.strftime(DATE_FMT)[:-3],
            "lapCount": len(laps),
            "laps": [
                {
                    "lapNumber": l.lap_number,
                    "durationSeconds": round(l.duration_seconds, 3),
                    "isFullLap": l.is_full_lap,
                }
                for l in laps
            ],
            "hasVideoFile": video_path.is_file(),
            "hasCachedVideo": (DERIVED_DIR / f"{stem}.mp4").is_file(),
        })
    sessions.sort(key=lambda s: s["dateTime"])
    return sessions


def load_session(dir_path: Path, session_id: str) -> None:
    """Load one session (identified by its video file name) from dir_path
    into the global LAPS/TRACK state, and kick off video resolution
    (cached mp4 / remux / raw mkv fallback). Raises LookupError if no .rnz
    in dir_path references that video."""
    matched: list[Lap] = []
    geometries: list[tuple[bool, dict]] = []
    for rnz_path in sorted(dir_path.glob("*.rnz")):
        try:
            lap, geometry = parse_rnz(rnz_path)
        except Exception as exc:
            print(f"Warning: could not read {rnz_path.name}: {exc}", file=sys.stderr)
            continue
        if lap.video_file_name != session_id:
            continue
        matched.append(lap)
        if geometry is not None:
            geometries.append((lap.is_full_lap, geometry))

    if not matched:
        raise LookupError(f"No session '{session_id}' found in {dir_path}")

    matched.sort(key=lambda l: l.lap_number)
    incomplete = [l.lap_number for l in matched if not l.is_full_lap]

    track_candidate = None
    for is_full, geometry in geometries:
        if track_candidate is None or (is_full and not track_candidate[0]):
            track_candidate = (is_full, geometry)

    with SESSION_LOCK:
        min_lap_number_hint.clear()
        if incomplete:
            min_lap_number_hint["value"] = min(incomplete)
        LAPS.clear()
        for lap in matched:
            LAPS[lap.lap_number] = lap
        TRACK.clear()
        if track_candidate is not None:
            TRACK.update(track_candidate[1])
        CURRENT["dir"] = str(dir_path)
        CURRENT["sessionId"] = session_id
        CURRENT["videoFileName"] = session_id
        CURRENT["generation"] = CURRENT.get("generation", 0) + 1

    resolve_video(dir_path, session_id)
    print(f"Loaded session '{session_id}' ({len(matched)} laps) from {dir_path}")


def find_ffmpeg() -> str | None:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def resolve_video(dir_path: Path, video_file_name: str) -> None:
    """Decide how the session's video will be served: a cached remux in
    derived/, a freshly-triggered background remux, or (no ffmpeg) the raw
    .mkv served directly. Never touches dir_path (read-only media folder)."""
    stem = Path(video_file_name).stem
    mp4_path = DERIVED_DIR / f"{stem}.mp4"
    mkv_path = dir_path / video_file_name
    generation = CURRENT.get("generation", 0)
    CURRENT["videoStem"] = stem

    if mp4_path.is_file():
        CURRENT.update(status="ready", videoUrl=f"/video/{stem}.mp4", percent=100.0, message=None)
        return

    if not mkv_path.is_file():
        CURRENT.update(status="error", videoUrl=None, percent=None,
                        message=f"Source video '{video_file_name}' not found in {dir_path}.")
        return

    ffmpeg_bin = find_ffmpeg()
    if ffmpeg_bin:
        DERIVED_DIR.mkdir(exist_ok=True)
        CURRENT.update(status="remuxing", videoUrl=None, percent=0.0, message=None,
                        srcSize=mkv_path.stat().st_size)
        thread = threading.Thread(
            target=run_remux, args=(ffmpeg_bin, mkv_path, mp4_path, generation), daemon=True
        )
        thread.start()
    else:
        CURRENT.update(
            status="raw", videoUrl=f"/video/{video_file_name}", percent=None,
            message=("ffmpeg was not found on this machine, so the original .mkv is served "
                      "directly. Seeking and overall compatibility depend on your browser "
                      "(Chrome usually plays H.264/AAC MKV; Firefox and Safari often don't)."),
        )


def run_remux(ffmpeg_bin: str, src: Path, dst: Path, generation: int) -> None:
    """Lossless remux (stream copy) in a background thread: mkv -> faststart
    mp4 in derived/. Writes to a .part file first and renames atomically so
    the /video endpoint never serves a half-written file."""
    part_path = dst.with_name(dst.name + ".part")
    try:
        subprocess.run(
            [ffmpeg_bin, "-y", "-i", str(src), "-c", "copy", "-movflags", "+faststart",
             "-f", "mp4", str(part_path)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
        )
        part_path.replace(dst)
        if CURRENT.get("generation") == generation:
            CURRENT.update(status="ready", videoUrl=f"/video/{dst.stem}.mp4", percent=100.0, message=None)
    except Exception as exc:
        try:
            part_path.unlink(missing_ok=True)
        except OSError:
            pass
        if CURRENT.get("generation") == generation:
            CURRENT.update(status="error", videoUrl=None, percent=None, message=f"Remux failed: {exc}")


def session_state_payload() -> dict:
    status = CURRENT.get("status", "none")
    percent = CURRENT.get("percent")
    if status == "remuxing":
        video_stem = CURRENT.get("videoStem")
        src_size = CURRENT.get("srcSize") or 0
        part_path = DERIVED_DIR / f"{video_stem}.mp4.part"
        try:
            if src_size and part_path.is_file():
                percent = min(99.0, round(part_path.stat().st_size / src_size * 100, 1))
        except OSError:
            pass
    return {
        "active": CURRENT.get("sessionId") is not None,
        "dir": CURRENT.get("dir"),
        "sessionId": CURRENT.get("sessionId"),
        "videoFileName": CURRENT.get("videoFileName"),
        "videoUrl": CURRENT.get("videoUrl"),
        "status": status,
        "percent": percent,
        "message": CURRENT.get("message"),
    }


def read_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(dir_path: Path) -> None:
    try:
        STATE_FILE.write_text(json.dumps({"lastFolder": str(dir_path)}), encoding="utf-8")
    except OSError as exc:
        print(f"Warning: could not write {STATE_FILE.name}: {exc}", file=sys.stderr)


def get_roots() -> list[dict]:
    """Convenience shortcuts for the folder picker: home, filesystem root,
    and anything mounted under /mnt (WSL: USB sticks and Windows drives)."""
    roots = [
        {"label": "Home", "path": str(Path.home())},
        {"label": "Filesystem root", "path": "/"},
    ]
    mnt = Path("/mnt")
    if mnt.is_dir():
        try:
            children = sorted(mnt.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            children = []
        for child in children:
            try:
                if not child.is_dir() or not os.access(child, os.R_OK):
                    continue
            except OSError:
                continue
            if len(child.name) == 1 and child.name.isalpha():
                label = f"Drive {child.name.upper()}: (Windows)"
            else:
                label = f"Mounted: {child.name}"
            roots.append({"label": label, "path": str(child)})
    return roots


def list_subdirs(dir_path: Path) -> list[dict]:
    out = []
    for child in sorted(dir_path.iterdir(), key=lambda p: p.name.lower()):
        if child.name.startswith("."):
            continue
        try:
            if child.is_dir():
                out.append({"name": child.name, "path": str(child)})
        except OSError:
            continue
    return out


def build_telemetry(lap: Lap) -> dict:
    # Valid samples first (igpsv = 1), keeping the original index so that
    # downsampling (every other original sample) stays identical to before.
    valid = [(i, sm) for i, sm in enumerate(lap.measurements_xml) if sm.get("igpsv") == "1"]

    # la/lo are smoothed at full 10 Hz resolution BEFORE downsampling, so
    # curb strikes/noise spikes are dampened as well as possible.
    lat_g_raw = [float(sm.get("la", "0")) / MILLI_G for _, sm in valid]
    lon_g_raw = [float(sm.get("lo", "0")) / MILLI_G for _, sm in valid]
    vert_g_raw = [float(sm.get("za", "0")) / MILLI_G for _, sm in valid]
    lat_g_smooth = moving_average(lat_g_raw, SMOOTH_WINDOW)
    lon_g_smooth = moving_average(lon_g_raw, SMOOTH_WINDOW)
    vert_g_smooth = moving_average(vert_g_raw, SMOOTH_WINDOW)

    t_list, speed_list, lat_list, lon_list, alt_list = [], [], [], [], []
    lat_g_list, lon_g_list, vert_g_list, heading_list = [], [], [], []
    for k, (i, sm) in enumerate(valid):
        # Downsampling to ~5 Hz (raw data is ~10 Hz): take every other valid sample.
        if i % 2 != 0:
            continue
        mt = parse_dt(sm.get("mt"))
        t = (mt - lap.video_start_time).total_seconds()
        gs = float(sm.get("gs"))
        t_list.append(round(t, 3))
        speed_list.append(round(gs * GS_TO_KMH, 1))
        lat_list.append(float(sm.get("lt")))
        lon_list.append(float(sm.get("lg")))
        alt_list.append(float(sm.get("al")))
        lat_g_list.append(round(lat_g_smooth[k], 3))
        lon_g_list.append(round(lon_g_smooth[k], 3))
        vert_g_list.append(round(vert_g_smooth[k], 3))
        heading_list.append(round(float(sm.get("dr", "0")), 1))
    return {
        "lapNumber": lap.lap_number,
        "t": t_list,
        "speedKmh": speed_list,
        "lat": lat_list,
        "lon": lon_list,
        "alt": alt_list,
        "latG": lat_g_list,
        "lonG": lon_g_list,
        "vertG": vert_g_list,
        "heading": heading_list,
    }


RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class Handler(BaseHTTPRequestHandler):
    server_version = "RingTaxiPlayer/1.0"

    def log_message(self, fmt, *args):  # quieter default logging
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))

    def _send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status, message):
        self._send_json({"error": message}, status=status)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except ValueError:
            return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)

        try:
            if path == "/api/laps":
                return self.handle_laps()
            if path == "/api/track":
                return self.handle_track()
            if path.startswith("/api/telemetry/"):
                return self.handle_telemetry(path[len("/api/telemetry/"):])
            if path == "/api/browse":
                return self.handle_browse(query)
            if path == "/api/sessions":
                return self.handle_sessions(query)
            if path == "/api/session":
                dir_val = (query.get("dir") or [None])[0]
                id_val = (query.get("id") or [None])[0]
                return self.handle_select_session(dir_val, id_val)
            if path in ("/api/session/status", "/api/session/current"):
                return self._send_json(session_state_payload())
            if path.startswith("/video/"):
                return self.handle_video(path[len("/video/"):])
            return self.handle_static(path)
        except BrokenPipeError:
            pass

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        try:
            if path == "/api/session":
                body = self._read_json_body()
                return self.handle_select_session(body.get("dir"), body.get("id"))
            return self._send_error_json(HTTPStatus.NOT_FOUND, "Not found")
        except BrokenPipeError:
            pass

    def handle_laps(self):
        laps = [LAPS[n].to_json() for n in sorted(LAPS)]
        self._send_json(laps)

    def handle_track(self):
        if not TRACK:
            return self._send_error_json(HTTPStatus.NOT_FOUND, "Track geometry not found")
        self._send_json(TRACK)

    def handle_telemetry(self, lap_str: str):
        try:
            lap_number = int(lap_str)
        except ValueError:
            return self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid lap number")
        lap = LAPS.get(lap_number)
        if lap is None:
            return self._send_error_json(HTTPStatus.NOT_FOUND, "Lap not found")
        self._send_json(build_telemetry(lap))

    def handle_browse(self, query: dict):
        path_param = (query.get("path") or [None])[0]
        target = path_param or read_state().get("lastFolder") or str(Path.home())
        try:
            resolved = Path(target).expanduser().resolve(strict=True)
        except (OSError, RuntimeError):
            return self._send_error_json(HTTPStatus.NOT_FOUND, f"Path not found: {target}")
        if not resolved.is_dir():
            return self._send_error_json(HTTPStatus.BAD_REQUEST, f"Not a directory: {resolved}")
        try:
            dirs = list_subdirs(resolved)
        except PermissionError:
            return self._send_error_json(HTTPStatus.FORBIDDEN, f"Permission denied: {resolved}")
        try:
            sessions = scan_sessions(resolved)
        except PermissionError:
            sessions = []
        parent = str(resolved.parent) if resolved.parent != resolved else None
        self._send_json({
            "path": str(resolved),
            "parent": parent,
            "dirs": dirs,
            "sessions": sessions,
            "roots": get_roots(),
        })

    def handle_sessions(self, query: dict):
        path_param = (query.get("path") or [None])[0]
        if not path_param:
            return self._send_error_json(HTTPStatus.BAD_REQUEST, "Missing 'path' parameter")
        try:
            resolved = Path(path_param).expanduser().resolve(strict=True)
        except (OSError, RuntimeError):
            return self._send_error_json(HTTPStatus.NOT_FOUND, f"Path not found: {path_param}")
        if not resolved.is_dir():
            return self._send_error_json(HTTPStatus.BAD_REQUEST, f"Not a directory: {resolved}")
        try:
            sessions = scan_sessions(resolved)
        except PermissionError:
            return self._send_error_json(HTTPStatus.FORBIDDEN, f"Permission denied: {resolved}")
        self._send_json({"path": str(resolved), "sessions": sessions})

    def handle_select_session(self, dir_str: str | None, session_id: str | None):
        if not dir_str or not session_id:
            return self._send_error_json(HTTPStatus.BAD_REQUEST, "Missing 'dir' or 'id'")
        try:
            resolved = Path(dir_str).expanduser().resolve(strict=True)
        except (OSError, RuntimeError):
            return self._send_error_json(HTTPStatus.NOT_FOUND, f"Folder not found: {dir_str}")
        if not resolved.is_dir():
            return self._send_error_json(HTTPStatus.BAD_REQUEST, f"Not a directory: {resolved}")
        try:
            load_session(resolved, session_id)
        except LookupError as exc:
            return self._send_error_json(HTTPStatus.NOT_FOUND, str(exc))
        except PermissionError:
            return self._send_error_json(HTTPStatus.FORBIDDEN, f"Permission denied: {resolved}")
        except Exception as exc:
            return self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"Failed to load session: {exc}")
        save_state(resolved)
        self._send_json(session_state_payload())

    def handle_video(self, name: str):
        if "/" in name or "\\" in name or name in ("", ".", ".."):
            return self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid file name")

        if name.lower().endswith(".mp4"):
            base_dir = DERIVED_DIR
            content_type = "video/mp4"
        elif name.lower().endswith(".mkv"):
            video_dir_str = CURRENT.get("dir")
            if not video_dir_str:
                return self._send_error_json(HTTPStatus.NOT_FOUND, "No active session")
            base_dir = Path(video_dir_str)
            content_type = "video/x-matroska"
        else:
            return self._send_error_json(HTTPStatus.BAD_REQUEST, "Unsupported video type")

        # The video must resolve inside derived/ or the active session's
        # (read-only) media folder - never anywhere else.
        file_path = (base_dir / name).resolve()
        try:
            file_path.relative_to(base_dir.resolve())
        except ValueError:
            return self._send_error_json(HTTPStatus.FORBIDDEN, "Forbidden")
        if not file_path.is_file():
            return self._send_error_json(HTTPStatus.NOT_FOUND, "Video not found")
        self._serve_file_with_range(file_path, content_type)

    def handle_static(self, path: str):
        if path == "/":
            path = "/index.html"
        # prevent path traversal
        rel = path.lstrip("/")
        file_path = (STATIC_DIR / rel).resolve()
        try:
            file_path.relative_to(STATIC_DIR.resolve())
        except ValueError:
            return self.send_error(HTTPStatus.FORBIDDEN)
        if not file_path.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self._serve_file_with_range(file_path, content_type)

    def _serve_file_with_range(self, file_path: Path, content_type: str):
        file_size = file_path.stat().st_size
        range_header = self.headers.get("Range")

        start, end = 0, file_size - 1
        status = HTTPStatus.OK
        is_partial = False

        if range_header:
            match = RANGE_RE.match(range_header.strip())
            if match:
                start_str, end_str = match.groups()
                if start_str == "" and end_str == "":
                    match = None
                elif start_str == "":
                    # suffix range: last N bytes
                    n = int(end_str)
                    start = max(0, file_size - n)
                    end = file_size - 1
                    is_partial = True
                else:
                    start = int(start_str)
                    end = int(end_str) if end_str else file_size - 1
                    is_partial = True
            if match is None and range_header:
                pass  # invalid Range header -> serve the whole file (fallback below)
            if is_partial:
                if start >= file_size or start > end:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{file_size}")
                    self.end_headers()
                    return
                end = min(end, file_size - 1)
                status = HTTPStatus.PARTIAL_CONTENT

        length = end - start + 1

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if is_partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()

        if self.command == "HEAD":
            return

        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = length
            chunk_size = 1024 * 256
            while remaining > 0:
                chunk = f.read(min(chunk_size, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except BrokenPipeError:
                    return
                remaining -= len(chunk)

    def do_HEAD(self):
        self.do_GET()


def main():
    parser = argparse.ArgumentParser(description="RingTaxi video player server")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    # Backward compatibility: if ./media contains a session, auto-load it as
    # the default so a fresh clone with media/ populated works exactly as
    # before, with no folder picker interaction required.
    try:
        if MEDIA_DIR.is_dir():
            sessions = scan_sessions(MEDIA_DIR)
            if sessions:
                load_session(MEDIA_DIR, sessions[0]["id"])
            else:
                print(f"No session found in {MEDIA_DIR} - use the folder picker in the UI.", file=sys.stderr)
        else:
            print(f"{MEDIA_DIR} does not exist - use the folder picker in the UI.", file=sys.stderr)
    except Exception as exc:
        print(f"Warning: could not auto-load default session: {exc}", file=sys.stderr)

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"Server running at http://localhost:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
