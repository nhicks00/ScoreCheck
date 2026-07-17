import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = await Promise.all([
  "../../commentary/deploy.sh",
  "../../compositor/deploy.sh",
  "../../mediamtx/deploy.sh",
  "../../monitoring/deploy-agent.sh",
  "../../monitoring/remote-deploy.sh"
].map(async (path) => [path, await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8")]));

test("remote deployments retry only idempotent Docker acquisition before runtime cutover", () => {
  for (const [path, script] of scripts) {
    assert.match(script, /retry_docker_operation\(\)/u, `${path} defines the bounded helper`);
    assert.match(script, /attempt >= 5/u, `${path} bounds retries`);
    assert.match(script, /delay_seconds=2/u, `${path} starts with a short backoff`);
    assert.match(script, /delay_seconds=\$\(\(delay_seconds \* 2\)\)/u, `${path} uses exponential backoff`);
  }

  const commentary = scripts[0][1];
  const compositor = scripts[1][1];
  const media = scripts[2][1];
  const agent = scripts[3][1];
  const monitoring = scripts[4][1];

  assert.match(commentary, /retry_docker_operation docker compose .* pull --quiet/u);
  assert.match(compositor, /retry_docker_operation docker compose pull --quiet/u);
  assert.doesNotMatch(compositor, /up -d --pull always/u);
  assert.match(media, /retry_docker_operation docker compose pull --quiet "\$\{services\[@\]\}"/u);
  assert.match(agent, /retry_docker_operation compose .* pull --quiet docker-proxy/u);
  assert.match(agent, /retry_docker_operation compose .* build --pull monitor-agent/u);
  assert.match(agent, /up -d --no-build --remove-orphans/u);
  assert.match(media, /install -d -m 0755 \/var\/lib\/scorecheck-monitoring\/ffmpeg/u);
  assert.match(agent, /install -d -m 0755 \/var\/lib\/scorecheck-monitoring\/ffmpeg/u);
  assert.match(monitoring, /retry_docker_operation docker build --pull/u);
});

test("all changed deployment entrypoints remain valid Bash", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const [path] of scripts) {
    const absolute = fileURLToPath(new URL(path, import.meta.url));
    const result = spawnSync("bash", ["-n", absolute], { encoding: "utf8" });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
  }
});

test("fresh public TLS endpoints retry handshake failures within a bounded deadline", () => {
  for (const [path, script] of scripts.slice(0, 3).filter(([path]) => path.includes("commentary") || path.includes("mediamtx"))) {
    assert.match(script, /--retry-all-errors/u, `${path} retries TLS handshake failures`);
    assert.match(script, /--retry-max-time 120/u, `${path} has a bounded readiness deadline`);
    assert.match(script, /--connect-timeout 5 --max-time 10/u, `${path} bounds each attempt`);
  }
});
