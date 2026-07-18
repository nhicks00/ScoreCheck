#!/usr/bin/env python3

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = re.compile(r"^/opt/scorecheck-rehearsal/[A-Za-z0-9-]{8,80}$")


def run(args):
    return subprocess.run(args, capture_output=True, text=True, check=False)


def unit_properties(unit):
    result = run([
        "/usr/bin/systemctl", "show", unit, "--no-pager",
        "--property=ActiveState,MainPID,NRestarts"
    ])
    values = {}
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                values[key] = value
    return values


def container_state(container):
    result = run(["/usr/bin/docker", "inspect", container])
    if result.returncode != 0:
        return {}
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}
    return value[0] if isinstance(value, list) and len(value) == 1 else {}


def finite(value):
    try:
        result = float(value)
        return result if result == result and abs(result) != float("inf") else None
    except (TypeError, ValueError):
        return None


def progress(path, now_ms):
    try:
        raw = path.read_text(encoding="utf-8")
        mtime_ms = path.stat().st_mtime * 1000
    except FileNotFoundError:
        return None
    fields = {}
    latest = None
    for line in raw.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        fields[key] = value
        if key == "progress":
            latest = fields
            fields = {}
    if latest is None:
        return None
    speed = str(latest.get("speed", "")).removesuffix("x")
    return {
        "status": latest.get("progress"),
        "frame": finite(latest.get("frame")),
        "framesPerSecond": finite(latest.get("fps")),
        "droppedFrames": finite(latest.get("drop_frames")),
        "duplicatedFrames": finite(latest.get("dup_frames")),
        "speedRatio": finite(speed),
        "ageMs": now_ms - mtime_ms,
    }


def main():
    if len(sys.argv) != 2 or not ROOT.fullmatch(sys.argv[1]):
        raise SystemExit("snapshot root is invalid")
    root = Path(sys.argv[1])
    observed = datetime.now(timezone.utc)
    now_ms = observed.timestamp() * 1000
    samples = []
    for court in range(1, 9):
        metadata_path = root / f"camera-{court}.metadata.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("schemaVersion") != 1 or metadata.get("court") != court:
            raise SystemExit(f"Camera {court} metadata is invalid")
        unit = unit_properties(metadata["unit"])
        container = container_state(metadata["container"])
        labels = container.get("Config", {}).get("Labels") or {}
        running = container.get("State", {}).get("Running") is True
        marker_matches = labels.get("scorecheck.rehearsal.marker") == metadata["marker"]
        active = unit.get("ActiveState") == "active"
        main_pid = int(unit.get("MainPID") or 0)
        ffmpeg_pid = int(container.get("State", {}).get("Pid") or 0)
        restarts = int(unit.get("NRestarts") or 0)
        state = "running" if active and running and marker_matches and main_pid >= 2 and ffmpeg_pid >= 2 else "invalid"
        samples.append({
            "court": court,
            "marker": metadata["marker"],
            "progress": progress(Path(metadata["progressPath"]), now_ms),
            "supervisor": {
                "state": state,
                "supervisorPid": main_pid if main_pid >= 2 else None,
                "ffmpegPid": ffmpeg_pid if ffmpeg_pid >= 2 else None,
                "restartCount": restarts,
                "lastRestartAt": None,
                "lastFailure": None,
                "ageMs": 0,
            },
        })
    print(json.dumps({
        "schemaVersion": 1,
        "observedAt": observed.isoformat().replace("+00:00", "Z"),
        "samples": samples,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
