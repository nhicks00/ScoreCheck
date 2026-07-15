import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export async function collectReconstructionProvenance({ spec, resource, expectedConfigHashes, runRemote }) {
  if (typeof runRemote !== "function") throw new Error("reconstruction provenance requires a remote runner");
  validateExpectedConfigHashes(expectedConfigHashes);
  const command = buildReconstructionCommand({ expectedConfigHashes });
  const result = await runRemote(command);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("reconstruction attestation returned invalid JSON");
  }
  return validateReconstructionProvenance({ payload, spec, resource, expectedConfigHashes });
}

export function buildReconstructionCommand({ expectedConfigHashes }) {
  validateExpectedConfigHashes(expectedConfigHashes);
  const input = Buffer.from(JSON.stringify({ paths: Object.keys(expectedConfigHashes).sort() }), "utf8").toString("base64");
  return `SCORECHECK_ATTESTATION_INPUT=${input} python3 - <<'PY'\n${REMOTE_ATTESTATION}\nPY`;
}

export function validateReconstructionProvenance({ payload, spec, resource, expectedConfigHashes }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.schemaVersion !== 1) {
    throw new Error("reconstruction attestation schema is invalid");
  }
  if (String(payload.providerDropletId ?? "") !== String(resource.id)) {
    throw new Error(`reconstruction attestation Droplet id mismatch for ${spec.name}`);
  }
  if (payload.hostname !== spec.providerName) {
    throw new Error(`reconstruction attestation hostname mismatch for ${spec.name}`);
  }
  if (payload.publicIpv4 !== resource.publicIpv4 || payload.privateIpv4 !== resource.privateIpv4) {
    throw new Error(`reconstruction attestation network identity mismatch for ${spec.name}`);
  }
  if (payload.cloudInitSha256 !== spec.cloudInitSha256) {
    throw new Error(`reconstruction attestation cloud-init mismatch for ${spec.name}`);
  }
  if (payload.ufw?.active !== true || !SHA256.test(payload.ufw.sha256 ?? "")) {
    throw new Error(`reconstruction attestation firewall is not active for ${spec.name}`);
  }
  for (const key of ["dockerVersion", "composeVersion", "os", "kernel", "capturedAt"]) {
    if (typeof payload[key] !== "string" || !payload[key]) throw new Error(`reconstruction attestation ${key} is missing for ${spec.name}`);
  }
  const configs = new Map((payload.configs ?? []).map((entry) => [entry.path, entry]));
  for (const [path, expectedSha256] of Object.entries(expectedConfigHashes)) {
    const entry = configs.get(path);
    if (!entry || entry.sha256 !== expectedSha256 || !SHA256.test(entry.sha256) || !Number.isInteger(entry.mode) || !Number.isInteger(entry.size)) {
      throw new Error(`reconstruction attestation config mismatch at ${path} for ${spec.name}`);
    }
  }
  if (!Array.isArray(payload.containers) || payload.containers.length === 0) {
    throw new Error(`reconstruction attestation has no containers for ${spec.name}`);
  }
  const names = new Set();
  for (const container of payload.containers) {
    if (!container || typeof container !== "object" || names.has(container.name)) throw new Error(`reconstruction attestation container inventory is invalid for ${spec.name}`);
    names.add(container.name);
    if (!["running", "exited", "created", "restarting", "paused", "dead"].includes(container.state)) {
      throw new Error(`reconstruction attestation container state is invalid for ${spec.name}`);
    }
    if (typeof container.imageRef !== "string" || !container.imageRef || typeof container.imageId !== "string" || !container.imageId.startsWith("sha256:")) {
      throw new Error(`reconstruction attestation container image is invalid for ${spec.name}`);
    }
    if (!Number.isInteger(container.restartCount) || container.restartCount < 0) {
      throw new Error(`reconstruction attestation container restart count is invalid for ${spec.name}`);
    }
  }
  return structuredClone(payload);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateExpectedConfigHashes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error("expected reconstruction config hashes are required");
  }
  for (const [path, digest] of Object.entries(value)) {
    if (!path.startsWith("/") || path.includes("..") || !SHA256.test(digest)) {
      throw new Error("expected reconstruction config hash binding is invalid");
    }
  }
}

const REMOTE_ATTESTATION = String.raw`import base64
import datetime
import hashlib
import json
import os
import platform
import stat
import subprocess
import urllib.request

def run(argv):
    result = subprocess.run(argv, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return result.stdout.strip()

def metadata(path):
    with urllib.request.urlopen("http://169.254.169.254/metadata/v1/" + path, timeout=3) as response:
        return response.read().decode("utf-8").strip()

def file_entry(path):
    with open(path, "rb") as handle:
        body = handle.read()
    info = os.stat(path)
    return {
        "path": path,
        "sha256": hashlib.sha256(body).hexdigest(),
        "size": info.st_size,
        "mode": stat.S_IMODE(info.st_mode),
    }

request = json.loads(base64.b64decode(os.environ["SCORECHECK_ATTESTATION_INPUT"]).decode("utf-8"))
containers = []
ids = [value for value in run(["docker", "ps", "-aq", "--no-trunc"]).splitlines() if value]
if ids:
    for item in json.loads(run(["docker", "inspect", *ids])):
        state = item.get("State") or {}
        config = item.get("Config") or {}
        containers.append({
            "name": str(item.get("Name") or "").lstrip("/"),
            "imageRef": str(config.get("Image") or ""),
            "imageId": str(item.get("Image") or ""),
            "state": str(state.get("Status") or ""),
            "health": str((state.get("Health") or {}).get("Status") or "none"),
            "restartCount": int(item.get("RestartCount") or 0),
            "startedAt": str(state.get("StartedAt") or ""),
            "revision": str((config.get("Labels") or {}).get("org.opencontainers.image.revision") or ""),
        })

os_release = {}
with open("/etc/os-release", "r", encoding="utf-8") as handle:
    for raw in handle:
        if "=" in raw:
            key, value = raw.rstrip("\n").split("=", 1)
            os_release[key] = value.strip().strip('"')

ufw_output = run(["ufw", "status", "verbose"])
payload = {
    "schemaVersion": 1,
    "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "providerDropletId": metadata("id"),
    "hostname": platform.node(),
    "publicIpv4": metadata("interfaces/public/0/ipv4/address"),
    "privateIpv4": metadata("interfaces/private/0/ipv4/address"),
    "region": metadata("region"),
    "os": os_release.get("PRETTY_NAME", "unknown"),
    "kernel": platform.release(),
    "dockerVersion": run(["docker", "version", "--format", "{{.Server.Version}}"]),
    "composeVersion": run(["docker", "compose", "version", "--short"]),
    "cloudInitSha256": file_entry("/var/lib/cloud/instance/user-data.txt")["sha256"],
    "ufw": {
        "active": ufw_output.splitlines()[0].strip().lower() == "status: active",
        "sha256": hashlib.sha256(ufw_output.encode("utf-8")).hexdigest(),
    },
    "configs": [file_entry(path) for path in request["paths"]],
    "containers": sorted(containers, key=lambda value: value["name"]),
}
print(json.dumps(payload, separators=(",", ":"), sort_keys=True))`;
