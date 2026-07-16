import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const deployPath = fileURLToPath(new URL("../deploy.sh", import.meta.url));
const remoteDeployPath = fileURLToPath(new URL("../remote-deploy.sh", import.meta.url));
const dockerignorePath = fileURLToPath(new URL("../.dockerignore", import.meta.url));
const testFeedDockerfilePath = fileURLToPath(new URL("../Dockerfile.test-feed", import.meta.url));
const testFeedRunnerPath = fileURLToPath(new URL("../run-test-feed-container.sh", import.meta.url));
const deploy = readFileSync(deployPath, "utf8");
const remoteDeploy = readFileSync(remoteDeployPath, "utf8");
const dockerignore = readFileSync(dockerignorePath, "utf8");
const testFeedDockerfile = readFileSync(testFeedDockerfilePath, "utf8");
const testFeedRunner = readFileSync(testFeedRunnerPath, "utf8");

describe("staged observability deployment", () => {
  it("keeps both shell entrypoints syntactically valid", () => {
    for (const path of [deployPath, remoteDeployPath]) {
      const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it("requires a clean exact revision and excludes secrets from the build context", () => {
    expect(deploy).toContain('status --porcelain)');
    expect(deploy).toContain('rev-parse HEAD');
    expect(deploy).toContain('^/[A-Za-z0-9._/-]+$');
    expect(deploy).toContain('"$REMOTE_DIR" == "/"');
    expect(deploy).toContain("trap 'exit 143' TERM");
    expect(dockerignore.trim().split("\n")).toEqual([
      "**",
      "!Dockerfile",
      "!Dockerfile.test-feed",
      "!package.json",
      "!package-lock.json",
      "!tsconfig.json",
      "!run-test-feed-fault.mjs",
      "!src/",
      "!src/**"
    ]);
  });

  it("runs test feeds in a source-pinned least-privilege container", () => {
    const syntax = spawnSync("bash", ["-n", testFeedRunnerPath], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(testFeedDockerfile).toMatch(/^FROM node:[^\n]+@sha256:[a-f0-9]{64}$/m);
    expect(testFeedDockerfile).toContain('ARG FFMPEG_VERSION=8.1.2-r0');
    expect(testFeedDockerfile).toContain('"ffmpeg=${FFMPEG_VERSION}"');
    expect(testFeedDockerfile).toContain('USER node');
    expect(testFeedDockerfile).toContain('ENTRYPOINT ["node", "/app/run-test-feed-fault.mjs"]');
    expect(testFeedRunner).toContain('--read-only');
    expect(testFeedRunner).toContain('--cap-drop ALL');
    expect(testFeedRunner).toContain('--security-opt no-new-privileges');
    expect(testFeedRunner).toContain('--pids-limit 128');
    expect(testFeedRunner).toContain('--memory 1536m');
    expect(testFeedRunner).toContain('--cpus 2');
    expect(testFeedRunner).toContain('mktemp -d "$output_dir/.scorecheck-test-feed.XXXXXX"');
    expect(testFeedRunner).toContain('--mount "type=bind,src=$run_dir,dst=/evidence"');
    expect(testFeedRunner).toContain('ln "$run_output" "$output"');
    expect(testFeedRunner).toContain('docker_args+=(--env "$name")');
    expect(testFeedRunner).not.toMatch(/--env-file|--privileged|--network host/);
  });

  it("rejects topology changes before any image build or runtime cutover", () => {
    const topologyGate = remoteDeploy.indexOf("Routine deployment rejected infrastructure change");
    const imageBuild = remoteDeploy.indexOf("docker build --label");
    const cutover = remoteDeploy.indexOf("rollback_required=1");

    expect(topologyGate).toBeGreaterThan(0);
    expect(imageBuild).toBeGreaterThan(topologyGate);
    expect(cutover).toBeGreaterThan(imageBuild);
    expect(remoteDeploy).toContain("docker-compose.yml Caddyfile .generated/alertmanager.yml");
    expect(remoteDeploy).toContain('chmod 0444 \\\n  "$CANDIDATE_DIR/.generated/prometheus.yml"');
  });

  it("recreates only monitor-service and preserves every unaffected container", () => {
    expect(remoteDeploy).not.toContain("--remove-orphans");
    expect(remoteDeploy).not.toContain("compose up -d --build");
    expect(remoteDeploy).toContain("compose up -d --no-deps --force-recreate --no-build monitor-service");
    expect(remoteDeploy).toContain("for service in prometheus alertmanager caddy node-exporter");
    expect(remoteDeploy).toContain("assert_static_container_ids");
  });

  it("publishes rules only after candidate service and public health succeed", () => {
    const candidateWait = remoteDeploy.indexOf('if ! wait_for_monitor "$REVISION"');
    const publicHealth = remoteDeploy.indexOf("wait_for_public_health", candidateWait);
    const rulesCutover = remoteDeploy.indexOf("# Only after the new service is healthy", publicHealth);
    const prometheusReload = remoteDeploy.indexOf("http://127.0.0.1:9090/-/reload", rulesCutover);

    expect(candidateWait).toBeGreaterThan(0);
    expect(publicHealth).toBeGreaterThan(candidateWait);
    expect(rulesCutover).toBeGreaterThan(publicHealth);
    expect(prometheusReload).toBeGreaterThan(rulesCutover);
  });

  it("waits for a successful Prometheus sample from after the candidate cutover", () => {
    expect(remoteDeploy).toContain('candidate_cutover_epoch="$(date +%s)"');
    expect(remoteDeploy).toContain('wait_for_prometheus_monitor "$candidate_cutover_epoch"');
    expect(remoteDeploy).toContain('(.data.result[0].value[0] | tonumber) >= $minimum');
    expect(remoteDeploy).toContain('Prometheus did not observe a successful post-cutover monitor-service scrape within 60 seconds.');
    expect(remoteDeploy).not.toContain(".data.result[0].value[1] == \"1\"' >/dev/null");
  });

  it("never evaluates protected service environment values as shell code", () => {
    expect(remoteDeploy).not.toMatch(/(^|\n)\s*\.\s+"?\$REMOTE_DIR\/\.env"?/);
    expect(remoteDeploy).not.toContain("source \"$REMOTE_DIR/.env\"");
    expect(remoteDeploy).toContain("read_json_env_value");
    expect(remoteDeploy).toContain("jq -Rer 'fromjson");
    expect(remoteDeploy).toContain('"$name" == "MONITOR_PUBLIC_HOST"');
    expect(remoteDeploy).toContain('"$encoded" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$');
    expect(remoteDeploy).toContain("assert_public_health");
    expect(remoteDeploy).toContain("wait_for_public_health");
    expect(remoteDeploy).toContain("Public monitor health did not become ready within 60 seconds.");
    expect(remoteDeploy).toContain("assert_control_plane_ready");

    const decoded = spawnSync(
      "jq",
      ["-Rer", 'fromjson | select(type == "string" and length > 0)'],
      { input: '"monitor.beachvolleyballmedia.com"\n', encoding: "utf8" }
    );
    expect(decoded.status, decoded.stderr).toBe(0);
    expect(decoded.stdout.trim()).toBe("monitor.beachvolleyballmedia.com");
  });

  it("restores runtime and source provenance when a staged cutover fails", () => {
    expect(remoteDeploy).toContain('install -m 0600 "$backup_dir/.env" "$REMOTE_DIR/.env"');
    expect(remoteDeploy).toContain('rsync -a --delete "$backup_dir/rules/" "$REMOTE_DIR/rules/"');
    expect(remoteDeploy).toContain('restore_provenance || failed=1');
    expect(remoteDeploy).toContain('docker tag "$rollback_image" scorecheck-monitoring:local');
    expect(remoteDeploy).toContain('wait_for_monitor "$old_revision"');
    expect(remoteDeploy).toContain("Automatic rollback requires operator attention.");
  });
});
