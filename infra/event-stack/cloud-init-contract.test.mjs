import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const vpcCidr = "10.120.0.0/20";
const profiles = {
  commentary: resolve(root, "infra/commentary/cloud-init.yaml"),
  compositor: resolve(root, "infra/compositor/cloud-init.yaml"),
  ingest: resolve(root, "infra/mediamtx/cloud-init.yaml"),
  observability: resolve(root, "infra/monitoring/cloud-init.yaml")
};

test("every event host disables password SSH and retains key-only root recovery", async () => {
  for (const [name, path] of Object.entries(profiles)) {
    const source = await readFile(path, "utf8");
    assert.match(source, /^ssh_pwauth: false$/m, `${name} must disable cloud-init password authentication`);
    assert.match(source, /PasswordAuthentication no/);
    assert.match(source, /KbdInteractiveAuthentication no/);
    assert.match(source, /PermitRootLogin prohibit-password/);
    assert.match(source, /X11Forwarding no/);
    assert.match(source, /LogLevel VERBOSE/);
    assert.match(source, /systemctl reload ssh/);
    assert.match(source, /systemctl mask --now fwupd-refresh\.timer fwupd-refresh\.service \|\| true/, `${name} must suppress deferred firmware metadata refresh`);
    assert.doesNotMatch(source, /PasswordAuthentication yes|PermitRootLogin yes/);
  }
});

test("host firewalls mirror public role exposure and keep agent telemetry private", async () => {
  const commentary = await readFile(profiles.commentary, "utf8");
  for (const command of [
    "ufw allow 22/tcp",
    "ufw allow 80/tcp",
    "ufw allow 443/tcp",
    "ufw allow 7881/tcp",
    "ufw allow 3478/udp",
    "ufw allow 50000:60000/udp"
  ]) assert.match(commentary, new RegExp(escapeRegexp(command)));
  assert.match(commentary, new RegExp(`ufw allow from ${escapeRegexp(vpcCidr)} to any port 9108 proto tcp`));

  const compositor = await readFile(profiles.compositor, "utf8");
  assert.match(compositor, /ufw allow 22\/tcp/);
  assert.match(compositor, new RegExp(`ufw allow from ${escapeRegexp(vpcCidr)} to any port 9108 proto tcp`));
  assert.doesNotMatch(compositor, /ufw allow (80|443|7880)\/tcp/);

  const ingest = await readFile(profiles.ingest, "utf8");
  assert.match(ingest, /^  - wireguard-tools$/m);
  assert.match(ingest, /install -d -m 0755 \/var\/lib\/scorecheck-monitoring\/ffmpeg/);
  for (const command of ["22/tcp", "80/tcp", "443/tcp", "1935/tcp", "8189/udp", "8890/udp", "51820/udp"]) {
    assert.match(ingest, new RegExp(`ufw allow ${escapeRegexp(command)}`));
  }
  assert.match(ingest, new RegExp(`ufw allow from ${escapeRegexp(vpcCidr)} to any port 9108 proto tcp`));
  assert.match(ingest, new RegExp(`ufw allow from ${escapeRegexp(vpcCidr)} to any port 8554 proto tcp`));

  const observability = await readFile(profiles.observability, "utf8");
  for (const command of ["22/tcp", "80/tcp", "443/tcp"]) assert.match(observability, new RegExp(`ufw allow ${escapeRegexp(command)}`));
  assert.match(observability, /ufw allow from 172\.30\.255\.0\/28 to any port 9108 proto tcp/);
  assert.doesNotMatch(observability, new RegExp(`ufw allow from ${escapeRegexp(vpcCidr)} to any port 9108 proto tcp`));
  const observabilityCompose = await readFile(resolve(root, "infra/monitoring/docker-compose.yml"), "utf8");
  assert.match(observabilityCompose, /subnet: 172\.30\.255\.0\/28/);
  assert.match(observabilityCompose, /MONITOR_ACME_EMAIL: "\$\{MONITOR_ACME_EMAIL\}"/);
  assert.match(observabilityCompose, /\.\/caddy_data:\/data/);
  assert.doesNotMatch(observabilityCompose, /^\s+caddy-data:$/m);

  const observabilityCaddy = await readFile(resolve(root, "infra/monitoring/Caddyfile"), "utf8");
  assert.match(observabilityCaddy, /dir https:\/\/acme\.zerossl\.com\/v2\/DV90/);
  assert.match(observabilityCaddy, /dir https:\/\/acme-v02\.api\.letsencrypt\.org\/directory/);
  assert.equal((observabilityCaddy.match(/email \{\$MONITOR_ACME_EMAIL\}/g) ?? []).length, 2);

  const observabilityProvision = await readFile(resolve(root, "infra/monitoring/remote-provision.sh"), "utf8");
  assert.match(observabilityProvision, /install -d -m 0700 "\$REMOTE_DIR\/\.generated" "\$REMOTE_DIR\/caddy_data"/);

  const ingestCompose = await readFile(resolve(root, "infra/mediamtx/docker-compose.yml"), "utf8");
  assert.match(ingestCompose, /\.\/caddy_data:\/data/);
  assert.doesNotMatch(ingestCompose, /^\s+caddy-data:$/m);
  const ingestDeploy = await readFile(resolve(root, "infra/mediamtx/deploy.sh"), "utf8");
  assert.match(ingestDeploy, /install -d -m 0700 '\$REMOTE_DIR\/caddy_data'/);

  for (const source of [commentary, compositor, ingest, observability]) {
    assert.match(source, /ufw default deny incoming/);
    assert.match(source, /ufw --force enable/);
  }
});

function escapeRegexp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
