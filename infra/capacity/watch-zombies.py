#!/usr/bin/env python3

import argparse
import hashlib
import json
import math
import os
import signal
import sys
import time
import urllib.request
from datetime import datetime, timezone


SCHEMA_VERSION = 1
ALLOWED_ROLES = {"ingest", "compositor"}
HEARTBEAT_SECONDS = 1.0
CACHE_RETENTION_SECONDS = 5.0
ORPHANED_HEALTHCHECK_COMMANDS = {
    "healthcheck.caddy": "caddy",
    "healthcheck.egress": "curl",
    "healthcheck.mediamtx": "wget",
    "healthcheck.redis": "redis-cli",
}


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def utc_from_epoch(epoch_seconds):
    return datetime.fromtimestamp(epoch_seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fingerprint(value):
    return hashlib.sha256(value).hexdigest()[:16] if value else None


def machine_fingerprint():
    machine_id = read_bytes("/etc/machine-id").strip()
    product_uuid = read_bytes("/sys/class/dmi/id/product_uuid").strip()
    if not machine_id and not product_uuid:
        return None
    return fingerprint(machine_id + b"\0" + product_uuid)


def digitalocean_identity():
    try:
        with urllib.request.urlopen(
            "http://169.254.169.254/metadata/v1.json", timeout=2.0
        ) as response:
            payload = json.load(response)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return digitalocean_identity_from_payload(payload)


def digitalocean_identity_from_payload(payload):
    if not isinstance(payload, dict):
        return None
    resource_id = str(payload.get("droplet_id", ""))
    hostname = payload.get("hostname")
    if not resource_id.isdigit() or resource_id.startswith("0"):
        return None
    if not isinstance(hostname, str) or not hostname or len(hostname) > 253:
        return None
    if not all(character.isalnum() or character in "_.-" for character in hostname):
        return None
    return {"provider": "digitalocean", "resourceId": resource_id, "hostname": hostname}


def read_bytes(path):
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        return b""


def read_text(path):
    return read_bytes(path).decode("utf-8", "replace")


def process_from_proc(pid):
    raw_stat = read_text(f"/proc/{pid}/stat")
    closing = raw_stat.rfind(")")
    opening = raw_stat.find("(")
    if opening < 0 or closing < opening:
        return None
    fields = raw_stat[closing + 2 :].split()
    if len(fields) < 20:
        return None
    try:
        ppid = int(fields[1])
        start_ticks = int(fields[19])
    except ValueError:
        return None
    command = raw_stat[opening + 1 : closing][:64]
    cmdline = read_bytes(f"/proc/{pid}/cmdline").replace(b"\0", b" ").strip()
    cgroup = read_bytes(f"/proc/{pid}/cgroup")
    try:
        executable = os.path.basename(os.readlink(f"/proc/{pid}/exe"))[:64]
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        executable = None
    return {
        "pid": pid,
        "ppid": ppid,
        "state": fields[0],
        "startTicks": start_ticks,
        "identity": f"{pid}:{start_ticks}",
        "command": command,
        "executable": executable,
        "commandLine": cmdline,
        "commandFingerprint": fingerprint(cmdline),
        "cgroupFingerprint": fingerprint(cgroup),
    }


def scan_processes():
    processes = {}
    try:
        entries = os.listdir("/proc")
    except OSError:
        return processes
    for entry in entries:
        if not entry.isdigit():
            continue
        process = process_from_proc(int(entry))
        if process is not None:
            processes[process["pid"]] = process
    for process in processes.values():
        parent = processes.get(process["ppid"])
        process["parentCommand"] = parent["command"] if parent else None
    return processes


def direct_classification(process):
    command = process["command"]
    parent_command = process.get("parentCommand")
    cmdline = process.get("commandLine") or b""

    if b"MONITOR_AGENT_BIND" in cmdline and b"/healthz" in cmdline and b"fetch(" in cmdline:
        return "healthcheck.monitor-agent"
    if command == "caddy" and cmdline == b"caddy validate --config /etc/caddy/Caddyfile":
        return "healthcheck.caddy"
    if b"curl -fsS http://127.0.0.1:9091/" in cmdline:
        return "healthcheck.egress"
    if b"wget -qO- http://127.0.0.1:9997/v3/config/global/get" in cmdline:
        return "healthcheck.mediamtx"
    if command == "redis-cli" and cmdline.rstrip().endswith(b" ping"):
        return "healthcheck.redis"
    if command == "sshd" and parent_command in {"sshd", "systemd"}:
        return "observer.capacity-ssh"
    return None


def container_healthcheck_classification(process):
    cmdline = (process.get("commandLine") or b"").strip()
    if cmdline == b"caddy run --config /etc/caddy/Caddyfile --adapter caddyfile":
        return "healthcheck.caddy"
    if cmdline == b"npm run start:agent":
        return "healthcheck.monitor-agent"
    if cmdline == b"/mediamtx":
        return "healthcheck.mediamtx"
    if cmdline == b"/tini -- egress":
        return "healthcheck.egress"
    if cmdline == b"redis-server *:6379":
        return "healthcheck.redis"
    return None


def healthcheck_shim_map(processes):
    healthcheck_shims = {}
    for process in processes.values():
        parent = processes.get(process["ppid"])
        if parent is None or parent["command"] != "containerd-shim":
            continue
        classification = container_healthcheck_classification(process)
        if classification is not None:
            healthcheck_shims[parent["identity"]] = {
                "pid": parent["pid"],
                "classification": classification,
                "cgroupFingerprint": process.get("cgroupFingerprint"),
            }
    return healthcheck_shims


def classification_map(processes, retained_healthcheck_shims=None):
    classifications = {}
    healthcheck_shims = dict(retained_healthcheck_shims or {})
    egress_inits = []
    for process in processes.values():
        if (process.get("commandLine") or b"").strip() == b"/tini -- egress":
            egress_inits.append(process)
    healthcheck_shims.update(healthcheck_shim_map(processes))

    for process in processes.values():
        classification = direct_classification(process)
        parent = processes.get(process["ppid"])
        healthcheck = healthcheck_shims.get(parent["identity"]) if parent else None
        if process["command"] == "runc" and healthcheck is not None:
            classification = f"{healthcheck['classification']}.runtime"
        elif (
            classification is None
            and healthcheck is not None
            and process.get("cgroupFingerprint") == healthcheck["cgroupFingerprint"]
            and process["command"] == ORPHANED_HEALTHCHECK_COMMANDS.get(healthcheck["classification"])
        ):
            classification = healthcheck["classification"]
        if classification is None:
            continue
        identity = process["identity"]
        classifications[identity] = classification
        parent_pid = process["ppid"]
        for _ in range(6):
            parent = processes.get(parent_pid)
            if parent is None:
                break
            if parent["command"] in {"runc", "sh", "bash"}:
                classifications[parent["identity"]] = f"{classification}.runtime"
            parent_pid = parent["ppid"]

    for process in processes.values():
        workload_classification = {
            ("chrome", "egress"): "workload.egress-chrome",
            ("chrome", "chrome"): "workload.egress-chrome",
            ("pactl", "egress"): "workload.egress-pactl",
            ("gst-plugin-scan", "egress"): "workload.egress-gst-plugin-scan",
        }.get((process["command"], process.get("parentCommand")))
        if workload_classification is None:
            continue
        for egress_init in egress_inits:
            if process.get("cgroupFingerprint") != egress_init.get("cgroupFingerprint"):
                continue
            if is_descendant(process, egress_init, processes):
                classifications[process["identity"]] = workload_classification
                break

    for _ in range(8):
        changed = False
        for process in processes.values():
            if process["identity"] in classifications:
                continue
            parent = processes.get(process["ppid"])
            parent_classification = classifications.get(parent["identity"]) if parent else None
            if parent_classification is None:
                continue
            if parent_classification.startswith("workload."):
                continue
            classifications[process["identity"]] = parent_classification
            changed = True
        if not changed:
            break
    return classifications


def is_descendant(process, ancestor, processes):
    current = process
    for _ in range(64):
        if current["identity"] == ancestor["identity"]:
            return True
        current = processes.get(current["ppid"])
        if current is None:
            return False
    return False


def safe_process(process, classification, initial_observation):
    return {
        "identity": process["identity"],
        "pid": process["pid"],
        "ppid": process["ppid"],
        "state": "Z",
        "command": process["command"],
        "parentCommand": process.get("parentCommand"),
        "executable": process.get("executable"),
        "commandFingerprint": process.get("commandFingerprint"),
        "cgroupFingerprint": process.get("cgroupFingerprint"),
        "classification": classification or "unclassified",
        "initialObservation": initial_observation,
    }


def emit(role, event, **values):
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "role": role,
        "event": event,
        "observedAt": utc_now(),
        **values,
    }
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_cpu_times():
    lines = read_text("/proc/stat").splitlines()
    if not lines:
        return None
    fields = lines[0].split()
    if not fields or fields[0] != "cpu" or len(fields) < 6:
        return None
    try:
        values = [int(value) for value in fields[1:]]
    except ValueError:
        return None
    return sum(values), values[3] + values[4]


def host_sample(processes, role, previous_cpu, sample_slot_epoch, observed_epoch):
    current_cpu = read_cpu_times()
    cpu_ratio = None
    if current_cpu is not None and previous_cpu is not None:
        total_delta = current_cpu[0] - previous_cpu[0]
        idle_delta = current_cpu[1] - previous_cpu[1]
        if total_delta > 0 and 0 <= idle_delta <= total_delta:
            cpu_ratio = 1 - (idle_delta / total_delta)

    shm_ratio = 0.0 if role == "ingest" else None
    if role == "compositor":
        egress = next(
            (process for process in processes.values() if (process.get("commandLine") or b"").strip() == b"/tini -- egress"),
            None,
        )
        if egress is not None:
            try:
                stats = os.statvfs(f"/proc/{egress['pid']}/root/dev/shm")
                total = stats.f_blocks * stats.f_frsize
                available = stats.f_bavail * stats.f_frsize
                if total > 0 and 0 <= available <= total:
                    shm_ratio = (total - available) / total
            except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
                shm_ratio = None

    sample_ok = cpu_ratio is not None and shm_ratio is not None
    emit(
        role,
        "host_sample",
        sampleSlotAt=utc_from_epoch(sample_slot_epoch),
        sampleLagMs=round(max(0, observed_epoch - sample_slot_epoch) * 1000, 3),
        sampleOk=sample_ok,
        cpuRatio=round(cpu_ratio, 6) if cpu_ratio is not None else None,
        shmRatio=round(shm_ratio, 6) if shm_ratio is not None else None,
    )
    return current_cpu


def run(role, poll_interval_ms, sample_interval_seconds, duration_seconds):
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGHUP, stop)

    poll_seconds = poll_interval_ms / 1000
    started = time.monotonic()
    last_scan = started
    next_heartbeat = started + HEARTBEAT_SECONDS
    maximum_scan_gap_ms = 0.0
    scan_count = 0
    process_cache = {}
    classification_cache = {}
    healthcheck_shim_cache = {}
    active_zombies = {}
    initial_scan = True
    previous_cpu = read_cpu_times()
    next_sample_epoch = (
        math.floor(time.time() / sample_interval_seconds) + 1
    ) * sample_interval_seconds if sample_interval_seconds else None

    provider_identity = digitalocean_identity()
    emit(
        role,
        "watcher_started",
        pollIntervalMs=poll_interval_ms,
        watcherPid=os.getpid(),
        machineFingerprint=machine_fingerprint(),
        provider=provider_identity["provider"] if provider_identity else None,
        providerResourceId=provider_identity["resourceId"] if provider_identity else None,
        providerHostname=provider_identity["hostname"] if provider_identity else None,
    )
    while not stopping and (duration_seconds == 0 or time.monotonic() - started < duration_seconds):
        scan_started = time.monotonic()
        maximum_scan_gap_ms = max(maximum_scan_gap_ms, (scan_started - last_scan) * 1000)
        last_scan = scan_started
        processes = scan_processes()
        scan_count += 1
        for identity, value in healthcheck_shim_map(processes).items():
            healthcheck_shim_cache[identity] = {**value, "lastSeenMonotonic": scan_started}
        for identity, value in list(healthcheck_shim_cache.items()):
            parent = processes.get(value["pid"])
            if parent is not None and parent["identity"] != identity:
                healthcheck_shim_cache.pop(identity, None)
            elif scan_started - value["lastSeenMonotonic"] > CACHE_RETENTION_SECONDS:
                healthcheck_shim_cache.pop(identity, None)
        current_classifications = classification_map(processes, healthcheck_shim_cache)

        for process in processes.values():
            identity = process["identity"]
            cached = process_cache.get(identity, {})
            merged = {**cached, **{key: value for key, value in process.items() if value not in (None, b"")}}
            merged["lastSeenMonotonic"] = scan_started
            process_cache[identity] = merged
            if identity in current_classifications:
                classification_cache[identity] = current_classifications[identity]

        zombies = {
            process["identity"]: process
            for process in processes.values()
            if process["state"] == "Z"
        }
        for identity, process in zombies.items():
            if identity in active_zombies:
                continue
            merged = {**process_cache.get(identity, {}), **process}
            classification = current_classifications.get(identity) or classification_cache.get(identity)
            active_zombies[identity] = {
                "openedMonotonic": scan_started,
                "process": safe_process(merged, classification, initial_scan),
            }
            emit(role, "zombie_open", **active_zombies[identity]["process"])

        for identity in list(active_zombies):
            if identity in zombies:
                continue
            opened = active_zombies.pop(identity)
            emit(
                role,
                "zombie_close",
                identity=identity,
                durationMs=round((scan_started - opened["openedMonotonic"]) * 1000, 3),
                classification=opened["process"]["classification"],
            )

        for identity, process in list(process_cache.items()):
            if identity not in active_zombies and scan_started - process["lastSeenMonotonic"] > CACHE_RETENTION_SECONDS:
                process_cache.pop(identity, None)
                classification_cache.pop(identity, None)

        if scan_started >= next_heartbeat:
            emit(
                role,
                "heartbeat",
                scanCount=scan_count,
                activeZombieCount=len(active_zombies),
                maximumScanGapMs=round(maximum_scan_gap_ms, 3),
            )
            maximum_scan_gap_ms = 0.0
            while next_heartbeat <= scan_started:
                next_heartbeat += HEARTBEAT_SECONDS

        observed_epoch = time.time()
        if next_sample_epoch is not None and observed_epoch >= next_sample_epoch:
            previous_cpu = host_sample(processes, role, previous_cpu, next_sample_epoch, observed_epoch)
            next_sample_epoch = (math.floor(observed_epoch / sample_interval_seconds) + 1) * sample_interval_seconds

        initial_scan = False
        elapsed = time.monotonic() - scan_started
        time.sleep(max(0, poll_seconds - elapsed))

    ended = time.monotonic()
    for identity, opened in active_zombies.items():
        emit(
            role,
            "zombie_observation_end",
            identity=identity,
            durationMs=round((ended - opened["openedMonotonic"]) * 1000, 3),
            classification=opened["process"]["classification"],
        )
    emit(role, "watcher_stopped", scanCount=scan_count, activeZombieCount=len(active_zombies))


def self_test():
    assert digitalocean_identity_from_payload({"droplet_id": 123, "hostname": "bvm-compositor-a"}) == {
        "provider": "digitalocean", "resourceId": "123", "hostname": "bvm-compositor-a"
    }
    assert digitalocean_identity_from_payload({"droplet_id": 0, "hostname": "bvm-compositor-a"}) is None
    assert digitalocean_identity_from_payload({"droplet_id": 123, "hostname": "bad hostname"}) is None
    assert digitalocean_identity_from_payload([]) is None
    base = {
        "command": "node",
        "parentCommand": "runc",
        "commandLine": b"node -e fetch('http://'+(process.env.MONITOR_AGENT_BIND||'127.0.0.1')+':9108/healthz')",
    }
    assert direct_classification(base) == "healthcheck.monitor-agent"
    assert direct_classification({"command": "caddy", "parentCommand": "runc", "commandLine": b"caddy validate --config /etc/caddy/Caddyfile"}) == "healthcheck.caddy"
    assert direct_classification({"command": "caddy", "parentCommand": "runc", "commandLine": b"caddy reload --config /tmp/operator.json"}) is None
    assert direct_classification({**base, "commandLine": b"node worker.js"}) is None
    assert direct_classification({"command": "pactl", "parentCommand": "chrome", "commandLine": b"pactl info"}) is None
    assert direct_classification({"command": "runc", "parentCommand": "dockerd", "commandLine": b"runc exec"}) is None
    assert direct_classification({"command": "sshd", "parentCommand": "sshd", "commandLine": b"sshd: root@notty"}) == "observer.capacity-ssh"
    assert direct_classification({"command": "sshd", "parentCommand": "systemd", "commandLine": b""}) == "observer.capacity-ssh"
    assert direct_classification({"command": "sshd", "parentCommand": "bash", "commandLine": b"sshd"}) is None
    assert container_healthcheck_classification({"commandLine": b"npm run start:agent"}) == "healthcheck.monitor-agent"
    assert container_healthcheck_classification({"commandLine": b"caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"}) == "healthcheck.caddy"
    assert container_healthcheck_classification({"commandLine": b"/mediamtx"}) == "healthcheck.mediamtx"
    assert container_healthcheck_classification({"commandLine": b"/tini -- egress"}) == "healthcheck.egress"
    assert container_healthcheck_classification({"commandLine": b"redis-server *:6379"}) == "healthcheck.redis"
    assert container_healthcheck_classification({"commandLine": b"npm run dev"}) is None

    processes = {
        10: {"pid": 10, "ppid": 1, "identity": "10:1", "command": "tini", "parentCommand": "containerd-shim", "commandLine": b"/tini -- egress", "cgroupFingerprint": "egress"},
        20: {"pid": 20, "ppid": 100, "identity": "20:2", "command": "chrome", "parentCommand": "egress", "commandLine": b"/opt/google/chrome/chrome", "cgroupFingerprint": "egress"},
        30: {"pid": 30, "ppid": 20, "identity": "30:3", "command": "chrome", "parentCommand": "chrome", "commandLine": b"", "cgroupFingerprint": "egress"},
        40: {"pid": 40, "ppid": 20, "identity": "40:4", "command": "chrome", "parentCommand": "chrome", "commandLine": b"", "cgroupFingerprint": "other"},
        50: {"pid": 50, "ppid": 1, "identity": "50:5", "command": "containerd-shim", "parentCommand": "systemd", "commandLine": b"containerd-shim-runc-v2", "cgroupFingerprint": "host"},
        60: {"pid": 60, "ppid": 50, "identity": "60:6", "command": "redis-server", "parentCommand": "containerd-shim", "commandLine": b"redis-server *:6379", "cgroupFingerprint": "redis"},
        70: {"pid": 70, "ppid": 50, "identity": "70:7", "command": "redis-cli", "parentCommand": "containerd-shim", "commandLine": b"", "cgroupFingerprint": "redis"},
        80: {"pid": 80, "ppid": 50, "identity": "80:8", "command": "redis-cli", "parentCommand": "containerd-shim", "commandLine": b"", "cgroupFingerprint": "other"},
        90: {"pid": 90, "ppid": 50, "identity": "90:9", "command": "node", "parentCommand": "containerd-shim", "commandLine": b"", "cgroupFingerprint": "redis"},
        100: {"pid": 100, "ppid": 10, "identity": "100:10", "command": "egress", "parentCommand": "tini", "commandLine": b"egress", "cgroupFingerprint": "egress"},
        110: {"pid": 110, "ppid": 100, "identity": "110:11", "command": "pactl", "parentCommand": "egress", "commandLine": b"", "cgroupFingerprint": "egress"},
        120: {"pid": 120, "ppid": 100, "identity": "120:12", "command": "pactl", "parentCommand": "egress", "commandLine": b"", "cgroupFingerprint": "other"},
        130: {"pid": 130, "ppid": 20, "identity": "130:13", "command": "pactl", "parentCommand": "chrome", "commandLine": b"", "cgroupFingerprint": "egress"},
        140: {"pid": 140, "ppid": 100, "identity": "140:14", "command": "gst-plugin-scan", "parentCommand": "egress", "commandLine": b"gst-plugin-scanner", "cgroupFingerprint": "egress"},
    }
    classifications = classification_map(processes)
    assert classifications["20:2"] == "workload.egress-chrome"
    assert classifications["30:3"] == "workload.egress-chrome"
    assert "40:4" not in classifications
    assert classifications["70:7"] == "healthcheck.redis"
    assert "80:8" not in classifications
    assert "90:9" not in classifications
    assert classifications["110:11"] == "workload.egress-pactl"
    assert "120:12" not in classifications
    assert "130:13" not in classifications
    assert classifications["140:14"] == "workload.egress-gst-plugin-scan"

    mediamtx_init = {
        200: {"pid": 200, "ppid": 1, "identity": "200:20", "command": "containerd-shim", "parentCommand": "systemd", "commandLine": b"containerd-shim-runc-v2", "cgroupFingerprint": "host"},
        210: {"pid": 210, "ppid": 200, "identity": "210:21", "command": "mediamtx", "parentCommand": "containerd-shim", "commandLine": b"/mediamtx", "cgroupFingerprint": "mediamtx"},
    }
    retained = healthcheck_shim_map(mediamtx_init)
    assert retained["200:20"]["classification"] == "healthcheck.mediamtx"
    runc_exit_race = {
        200: mediamtx_init[200],
        220: {"pid": 220, "ppid": 200, "identity": "220:22", "command": "runc", "parentCommand": "containerd-shim", "commandLine": b"", "cgroupFingerprint": "runtime"},
    }
    assert classification_map(runc_exit_race, retained)["220:22"] == "healthcheck.mediamtx.runtime"
    replaced_shim = {
        200: {**mediamtx_init[200], "identity": "200:99"},
        220: runc_exit_race[220],
    }
    assert "220:22" not in classification_map(replaced_shim, retained)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=sorted(ALLOWED_ROLES))
    parser.add_argument("--poll-ms", type=int, default=50)
    parser.add_argument("--sample-interval-seconds", type=int, default=0)
    parser.add_argument("--duration-seconds", type=float, default=0)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return args
    if args.role is None:
        parser.error("--role is required")
    if args.poll_ms < 25 or args.poll_ms > 250:
        parser.error("--poll-ms must be from 25 through 250")
    if args.sample_interval_seconds != 0 and not 5 <= args.sample_interval_seconds <= 60:
        parser.error("--sample-interval-seconds must be zero or from 5 through 60")
    if args.duration_seconds < 0:
        parser.error("--duration-seconds must be non-negative")
    return args


if __name__ == "__main__":
    arguments = parse_args()
    if arguments.self_test:
        self_test()
    else:
        run(arguments.role, arguments.poll_ms, arguments.sample_interval_seconds, arguments.duration_seconds)
