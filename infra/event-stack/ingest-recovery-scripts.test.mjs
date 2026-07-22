import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("rebinds a compositor once, accepts the converged state, and restores the prior binding on failed health", async () => {
  const harness = await shellHarness();
  const compositor = await compositorFixture("10.120.0.12");
  const script = join(root, "infra/compositor/rebind-ingest.sh");
  const environment = { ...process.env, PATH: `${harness.bin}:${process.env.PATH}`, COMPOSITOR_DIR: compositor };
  await execute(script, ["10.120.0.12", "10.120.0.21", "ingest.beachvolleyballmedia.com"], { env: environment });
  assert.match(await readFile(join(compositor, ".env"), "utf8"), /^MEDIAMTX_PRIVATE_HOST="10\.120\.0\.21"$/mu);
  const repeated = await execute(script, ["10.120.0.12", "10.120.0.21", "ingest.beachvolleyballmedia.com"], { env: environment });
  assert.match(repeated.stdout, /already converged/u);

  const failed = await compositorFixture("10.120.0.12");
  await assert.rejects(
    () => execute(script, ["10.120.0.12", "10.120.0.21", "ingest.beachvolleyballmedia.com"], {
      env: { ...environment, COMPOSITOR_DIR: failed, FAKE_EGRESS_HEALTH: "unhealthy" }
    }),
    /previous binding restored/u
  );
  assert.match(await readFile(join(failed, ".env"), "utf8"), /^MEDIAMTX_PRIVATE_HOST="10\.120\.0\.12"$/mu);
});

test("replaces only the monitoring target contract and rolls it back when service health fails", async () => {
  const harness = await shellHarness();
  const script = join(root, "infra/monitoring/replace-agent-targets.sh");
  const desired = monitorTargets();
  const monitoring = await monitoringFixture();
  const targetFile = join(monitoring, "targets.txt");
  const prometheusFile = join(monitoring, "prometheus-candidate.yml");
  await writeFile(targetFile, desired, { mode: 0o600 });
  await writeFile(prometheusFile, "new-prometheus-config\n", { mode: 0o600 });
  const environment = { ...process.env, PATH: `${harness.bin}:${process.env.PATH}`, MONITOR_REMOTE_DIR: monitoring };
  await execute(script, [targetFile, prometheusFile], { env: environment });
  assert.equal((await stat(targetFile).catch(() => null)), null);
  assert.equal((await stat(prometheusFile).catch(() => null)), null);
  assert.match(await readFile(join(monitoring, ".env"), "utf8"), /MONITOR_AGENT_TARGETS=/u);
  assert.equal(JSON.parse((await readFile(join(monitoring, ".env"), "utf8")).trim().split("=").slice(1).join("=")), desired);
  assert.equal(await readFile(join(monitoring, ".generated/prometheus.yml"), "utf8"), "new-prometheus-config\n");

  const failed = await monitoringFixture();
  const failedTarget = join(failed, "targets.txt");
  const failedPrometheus = join(failed, "prometheus-candidate.yml");
  await writeFile(failedTarget, desired, { mode: 0o600 });
  await writeFile(failedPrometheus, "new-prometheus-config\n", { mode: 0o600 });
  const original = await readFile(join(failed, ".env"), "utf8");
  const originalPrometheus = await readFile(join(failed, ".generated/prometheus.yml"), "utf8");
  await assert.rejects(
    () => execute(script, [failedTarget, failedPrometheus], { env: { ...environment, MONITOR_REMOTE_DIR: failed, FAKE_MONITOR_HEALTH: "unhealthy" } }),
    /previous environment and Prometheus config restored/u
  );
  assert.equal(await readFile(join(failed, ".env"), "utf8"), original);
  assert.equal(await readFile(join(failed, ".generated/prometheus.yml"), "utf8"), originalPrometheus);
});

test("attaches and detaches only the temporary ingest host firewall rules", async () => {
  const harness = await shellHarness();
  const statePath = join(harness.root, "ufw-rules.txt");
  await writeFile(statePath, "", { mode: 0o600 });
  const script = join(root, "infra/mediamtx/recovery-role.sh");
  const recoveryState = join(harness.root, "recovery-state");
  const environment = { ...process.env, PATH: `${harness.bin}:${process.env.PATH}`, FAKE_UFW_STATE: statePath, RECOVERY_STATE_DIR: recoveryState };
  await execute(script, ["firewall-attach", "10.120.0.0/20"], { env: environment });
  const attached = (await readFile(statePath, "utf8")).trim().split("\n");
  assert.deepEqual(attached, [
    "80/tcp", "443/tcp", "1935/tcp", "8189/udp", "8890/udp", "51820/udp",
    "from 10.120.0.0/20 to any port 8554 proto tcp"
  ]);
  await execute(script, ["firewall-attach", "10.120.0.0/20"], { env: environment });
  await execute(script, ["firewall-detach", "10.120.0.0/20"], { env: environment });
  assert.equal(await readFile(statePath, "utf8"), "");
  await execute(script, ["firewall-detach", "10.120.0.0/20"], { env: environment });

  await writeFile(statePath, "80/tcp\n", { mode: 0o600 });
  await assert.rejects(
    () => execute(script, ["firewall-attach", "10.120.0.0/20"], { env: environment }),
    /refusing to adopt pre-existing/u
  );
  await assert.rejects(
    () => execute(script, ["firewall-detach", "10.120.0.0/20"], { env: environment }),
    /unowned ingest firewall rules remain/u
  );
});

async function shellHarness() {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-ingest-shell-"));
  const bin = join(directory, "bin");
  await mkdir(bin, { mode: 0o700 });
  await executable(join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  await executable(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  await executable(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n");
  await executable(join(bin, "stat"), "#!/bin/sh\nif [ \"$1\" = -c ]; then echo 600; else /usr/bin/stat \"$@\"; fi\n");
  await executable(join(bin, "install"), `#!/bin/sh
if [ "$1" = -d ]; then exec /usr/bin/install "$@"; fi
mode="$2"
shift 2
if [ "$1" = -o ]; then shift 2; fi
if [ "$1" = -g ]; then shift 2; fi
exec /usr/bin/install -m "$mode" "$@"
`);
  await executable(join(bin, "chown"), "#!/bin/sh\nexit 0\n");
  await executable(join(bin, "curl"), "#!/bin/sh\nexit 0\n");
  await executable(join(bin, "docker"), `#!/bin/sh
if [ "$1" = inspect ]; then
  case "$*" in
    *State.Running*) echo true ;;
    *scorecheck-monitor-service*) echo "\${FAKE_MONITOR_HEALTH:-healthy}" ;;
    *ExtraHosts*)
      host=$(sed -n 's/^MEDIAMTX_PUBLIC_HOST="\\{0,1\\}\\([^"[:space:]]*\\)"\\{0,1\\}$/\\1/p' .env)
      ip=$(sed -n 's/^MEDIAMTX_PRIVATE_HOST="\\{0,1\\}\\([^"[:space:]]*\\)"\\{0,1\\}$/\\1/p' .env)
      printf '["%s:%s"]\\n' "$host" "$ip"
      ;;
    *) echo "\${FAKE_EGRESS_HEALTH:-healthy}" ;;
  esac
fi
if [ "$1 $2 $3 $4" = "compose ps -q prometheus" ]; then echo prometheus-id; fi
exit 0
`);
  await executable(join(bin, "ufw"), `#!/bin/sh
state="\${FAKE_UFW_STATE:?}"
if [ "$1 $2" = "show added" ]; then
  while IFS= read -r rule; do [ -n "$rule" ] && printf 'ufw allow %s\\n' "$rule"; done <"$state"
  exit 0
fi
if [ "$1" = allow ]; then
  shift
  printf '%s\\n' "$*" >>"$state"
  exit 0
fi
if [ "$1 $2 $3" = "--force delete allow" ]; then
  shift 3
  grep -Fvx "$*" "$state" >"$state.next" || true
  mv "$state.next" "$state"
  exit 0
fi
exit 0
`);
  return { root: directory, bin };
}

async function compositorFixture(address) {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-compositor-rebind-"));
  await mkdir(join(directory, "backups"), { mode: 0o700 });
  await writeFile(join(directory, "docker-compose.yml"), "services: {}\n", { mode: 0o600 });
  await writeFile(join(directory, ".env"), [
    `MEDIAMTX_PRIVATE_HOST="${address}"`,
    'MEDIAMTX_PUBLIC_HOST="ingest.beachvolleyballmedia.com"'
  ].join("\n") + "\n", { mode: 0o600 });
  return directory;
}

async function monitoringFixture() {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-monitor-targets-"));
  await mkdir(join(directory, "backups"), { mode: 0o700 });
  await mkdir(join(directory, ".generated"), { mode: 0o700 });
  await writeFile(join(directory, "docker-compose.yml"), "services: {}\n", { mode: 0o600 });
  await writeFile(join(directory, ".env"), 'MONITOR_AGENT_TARGETS="old|mediamtx|http://10.0.0.1:9108|abcdefghijklmnopqrstuvwxyz|"\n', { mode: 0o600 });
  await writeFile(join(directory, ".generated/prometheus.yml"), "old-prometheus-config\n", { mode: 0o600 });
  return directory;
}

function monitorTargets() {
  const targets = [
    "bvm-compositor-spare|mediamtx|http://10.120.0.21:9108|abcdefghijklmnopqrstuvwxyz|",
    "bvm-commentary-01|commentary|http://10.120.0.10:9108|bcdefghijklmnopqrstuvwxyza|",
    "bvm-observability-01|observability|http://10.120.0.11:9108|cdefghijklmnopqrstuvwxyzab|"
  ];
  for (let court = 1; court <= 8; court += 1) {
    targets.push(`bvm-compositor-${String.fromCharCode(96 + court)}|compositor|http://10.120.0.${12 + court}:9108|token${court}abcdefghijklmnopqrstuvwxyz|${court}`);
  }
  return targets.join(",");
}

async function executable(path, body) {
  await writeFile(path, body, { mode: 0o700 });
  await chmod(path, 0o700);
}
