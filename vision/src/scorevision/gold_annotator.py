"""Localhost gold-ledger annotator: mark real point events on corpus VODs.

Zero-dependency (stdlib) web app. Serves the NAS corpus VODs with HTTP Range
support so the browser video element can seek, overlays the OCR-proposed
rally markers as navigation hints, and records keyboard-marked human events
(near/far point, match start, set end, side switch, replay, timeout) to
``labels/gold-events.json`` per VOD — the raw material for human-reconciled
gold event ledgers (READINESS.md A2).

Run:
    uv run scorevision-gold --corpus "/Volumes/Nathan Footage/CV TRAINING DATA/corpus"
then open http://localhost:8770
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path

_VOD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,32}$")
_CHUNK = 512 * 1024


class AnnotatorState:
    def __init__(self, corpus: Path, backup_dir: Path) -> None:
        self.corpus = corpus
        self.backup_dir = backup_dir

    def video_path(self, vod_id: str) -> Path | None:
        if not _VOD_ID_RE.match(vod_id):
            return None
        candidates = sorted((self.corpus / vod_id).glob(f"{vod_id}*.mp4"))
        return candidates[-1] if candidates else None

    def gold_path(self, vod_id: str) -> Path:
        return self.corpus / vod_id / "labels" / "gold-events.json"

    def list_vods(self) -> list[dict]:
        vods = []
        for vod_dir in sorted(self.corpus.iterdir()):
            if not vod_dir.is_dir():
                continue
            video = self.video_path(vod_dir.name)
            if video is None:
                continue
            labels = vod_dir / "labels"
            proposals = 0
            if (labels / "rallies.json").is_file():
                try:
                    proposals = len(json.loads((labels / "rallies.json").read_text()))
                except (json.JSONDecodeError, OSError):
                    proposals = 0
            gold_events = 0
            gold_file = self.gold_path(vod_dir.name)
            if gold_file.is_file():
                try:
                    gold_events = len(json.loads(gold_file.read_text()).get("events", []))
                except (json.JSONDecodeError, OSError):
                    gold_events = 0
            title = None
            info = vod_dir / f"{vod_dir.name}.info.json"
            if info.is_file():
                try:
                    title = json.loads(info.read_text()).get("title")
                except (json.JSONDecodeError, OSError):
                    title = None
            vods.append(
                {
                    "id": vod_dir.name,
                    "title": title or vod_dir.name,
                    "size_gb": round(video.stat().st_size / 1e9, 2),
                    "proposals": proposals,
                    "gold_events": gold_events,
                }
            )
        return vods

    def proposals(self, vod_id: str) -> dict:
        labels = self.corpus / vod_id / "labels"
        out: dict = {"rallies": [], "events": []}
        rallies_file = labels / "rallies.json"
        if rallies_file.is_file():
            try:
                out["rallies"] = json.loads(rallies_file.read_text())
            except (json.JSONDecodeError, OSError):
                pass
        events_file = labels / "events.jsonl"
        if events_file.is_file():
            try:
                for line in events_file.read_text().splitlines():
                    record = json.loads(line)
                    if record.get("kind") in ("MATCH_START", "SET_END", "MATCH_FINAL"):
                        out["events"].append(
                            {
                                "t": record["t_seconds"],
                                "kind": record["kind"],
                                "teams": record.get("teams"),
                            }
                        )
            except (json.JSONDecodeError, OSError):
                pass
        return out

    def load_gold(self, vod_id: str) -> dict:
        path = self.gold_path(vod_id)
        if path.is_file():
            try:
                return json.loads(path.read_text())
            except (json.JSONDecodeError, OSError):
                pass
        return {"vod_id": vod_id, "events": [], "saved_at": None}

    def save_gold(self, vod_id: str, payload: dict) -> dict:
        events = payload.get("events", [])
        if not isinstance(events, list) or len(events) > 20000:
            raise ValueError("invalid events payload")
        document = {
            "vod_id": vod_id,
            "schema": "gold-events-v1",
            "events": events,
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        path = self.gold_path(vod_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(document, indent=1))
        tmp.replace(path)
        # Local backup in case the NAS write is later found corrupted.
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        (self.backup_dir / f"{vod_id}.json").write_text(json.dumps(document))
        return {"ok": True, "saved_at": document["saved_at"], "count": len(events)}


def _make_handler(state: AnnotatorState):
    page_html = (
        resources.files("scorevision").joinpath("data/gold_annotator.html").read_text()
    )

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quiet
            pass

        def _json(self, obj, status: int = 200) -> None:
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            try:
                self._route_get()
            except (BrokenPipeError, ConnectionResetError):
                pass

        def _route_get(self) -> None:
            path = self.path.split("?")[0]
            if path in ("/", "/index.html"):
                body = page_html.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/api/vods":
                self._json(state.list_vods())
                return
            match = re.match(r"^/api/vod/([A-Za-z0-9_-]+)/(proposals|gold)$", path)
            if match:
                vod_id, what = match.group(1), match.group(2)
                self._json(
                    state.proposals(vod_id) if what == "proposals" else state.load_gold(vod_id)
                )
                return
            match = re.match(r"^/video/([A-Za-z0-9_-]+)$", path)
            if match:
                self._stream_video(match.group(1))
                return
            self._json({"error": "not found"}, 404)

        def _stream_video(self, vod_id: str) -> None:
            video = state.video_path(vod_id)
            if video is None:
                self._json({"error": "no such vod"}, 404)
                return
            size = video.stat().st_size
            range_header = self.headers.get("Range")
            start, end = 0, size - 1
            status = 200
            if range_header:
                match = re.match(r"bytes=(\d*)-(\d*)", range_header)
                if match:
                    if match.group(1):
                        start = int(match.group(1))
                        if match.group(2):
                            end = min(int(match.group(2)), size - 1)
                    elif match.group(2):
                        start = max(0, size - int(match.group(2)))
                    status = 206
            if start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            length = end - start + 1
            self.send_response(status)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            with open(video, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(_CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

        def do_POST(self) -> None:  # noqa: N802
            match = re.match(r"^/api/vod/([A-Za-z0-9_-]+)/gold$", self.path)
            if not match:
                self._json({"error": "not found"}, 404)
                return
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 8 * 1024 * 1024:
                self._json({"error": "bad payload size"}, 400)
                return
            try:
                payload = json.loads(self.rfile.read(length))
                result = state.save_gold(match.group(1), payload)
                self._json(result)
            except (json.JSONDecodeError, ValueError, OSError) as error:
                self._json({"error": str(error)}, 400)

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument(
        "--backup-dir",
        type=Path,
        default=Path.home() / ".scorevision-stage" / "gold-backup",
    )
    args = parser.parse_args()
    if not args.corpus.is_dir():
        parser.error(f"corpus not found: {args.corpus}")
    state = AnnotatorState(args.corpus, args.backup_dir)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), _make_handler(state))
    print(f"gold annotator: http://localhost:{args.port}  (corpus: {args.corpus})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
