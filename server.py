#!/usr/bin/env python3
"""RingTaxi video player - local server.

Scans media/*.rnz at startup, parses RaceNavigator XML (in memory, without
writing anything to media/), and exposes a small JSON API plus a range-
supporting video endpoint for the finished remuxed MP4 file in derived/.

Standard library only - no external dependencies.
"""

from __future__ import annotations

import argparse
import io
import json
import mimetypes
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

BASE_DIR = Path(__file__).resolve().parent
MEDIA_DIR = BASE_DIR / "media"
DERIVED_DIR = BASE_DIR / "derived"
STATIC_DIR = BASE_DIR / "static"

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
min_lap_number_hint: dict = {}

LAPS: dict[int, Lap] = {}

# Track geometry (start/finish/sector lines + corner names) is parsed once at
# startup from <trackVariant><trackDataXml><definition> - all lap XML files
# in a session embed the same definition, but we prefer the full lap.
TRACK: dict = {}


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


def load_laps() -> None:
    LAPS.clear()
    TRACK.clear()
    incomplete_lap_numbers = []
    parsed = []
    track_candidate = None  # (is_full_lap, geometry) - prefers the full lap

    for rnz_path in sorted(MEDIA_DIR.glob("*.rnz")):
        try:
            with zipfile.ZipFile(rnz_path) as zf:
                names = [n for n in zf.namelist() if n.lower().endswith(".rn")]
                if not names:
                    continue
                xml_bytes = zf.read(names[0])
        except (zipfile.BadZipFile, KeyError) as exc:
            print(f"Warning: could not read {rnz_path.name}: {exc}", file=sys.stderr)
            continue

        root = ET.fromstring(xml_bytes)
        lap_el = root.find("r:lap", NS)
        lap_number = int(lap_el.find("r:lapNumber", NS).text)
        start_time = parse_dt(lap_el.find("r:startTime", NS).text)
        end_time = parse_dt(lap_el.find("r:endTime", NS).text)
        is_start_crossed = lap_el.find("r:isStartLineCrossed", NS).text.strip() == "1"
        is_end_crossed = lap_el.find("r:isEndLineCrossed", NS).text.strip() == "1"

        if track_candidate is None or (is_start_crossed and is_end_crossed and not track_candidate[0]):
            geometry = parse_track_geometry(root)
            if geometry is not None:
                track_candidate = (is_start_crossed and is_end_crossed, geometry)

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

        if not (is_start_crossed and is_end_crossed):
            incomplete_lap_numbers.append(lap_number)

        parsed.append(Lap(
            lap_number=lap_number,
            start_time=start_time,
            end_time=end_time,
            is_start_crossed=is_start_crossed,
            is_end_crossed=is_end_crossed,
            video_file_name=video_file_name,
            video_start_time=video_start_time,
            sectors=sectors,
            measurements_xml=sm_elements,
        ))

    if incomplete_lap_numbers:
        min_lap_number_hint["value"] = min(incomplete_lap_numbers)

    for lap in parsed:
        LAPS[lap.lap_number] = lap

    if track_candidate is not None:
        TRACK.update(track_candidate[1])

    print(f"Loaded {len(LAPS)} laps from {MEDIA_DIR}")


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

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        try:
            if path == "/api/laps":
                return self.handle_laps()
            if path == "/api/track":
                return self.handle_track()
            if path.startswith("/api/telemetry/"):
                return self.handle_telemetry(path[len("/api/telemetry/"):])
            if path.startswith("/video/"):
                return self.handle_video(path[len("/video/"):])
            return self.handle_static(path)
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

    def handle_video(self, name: str):
        if "/" in name or "\\" in name:
            return self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid file name")
        file_path = DERIVED_DIR / name
        if not file_path.is_file():
            return self._send_error_json(HTTPStatus.NOT_FOUND, "Video not found")
        self._serve_file_with_range(file_path, "video/mp4")

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

    load_laps()

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
