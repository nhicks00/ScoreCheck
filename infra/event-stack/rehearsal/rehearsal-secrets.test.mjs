import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildEventManifest, loadManifestInputs } from "../event-manifest.mjs";
import { buildRehearsalVercelEnvironment, completeAgentSecrets, createRehearsalSecretMaterial, renderRehearsalSecretDirectory } from "./rehearsal-secrets.mjs";

const inputs = await loadManifestInputs();
const manifest = buildEventManifest({ event: "secret-test", kind: "rehearsal", destroyAfter: "2026-08-01", ...inputs });
const deterministic = (length) => Buffer.alloc(length, 7);
const renderer = {
  origin: "https://scorecheck-rehearsal-abc123-test.vercel.app",
  deploymentId: "dpl_renderer123",
  gitSha: "a".repeat(40)
};

test("generates isolated Vercel configuration without Supabase", () => {
  const material = createRehearsalSecretMaterial({ random: deterministic });
  const environment = buildRehearsalVercelEnvironment({ manifest, material, programOrigin: "https://scorecheck-rehearsal-test.vercel.app" });
  assert.equal(environment.MEDIAMTX_WHEP_BASE_URL, `https://${manifest.endpoints.find((entry) => entry.role === "ingest").hostname}`);
  assert.equal(Object.keys(environment).some((key) => key.startsWith("SUPABASE_")), false);
  assert.equal(environment.SCORECHECK_REHEARSAL_ORIGIN, "https://scorecheck-rehearsal-test.vercel.app");
  assert.equal(environment.ADMIN_SECRET, material.adminSecret);
  assert.equal(environment.COMMENTATOR_PASSCODE, material.commentatorPasscode);
});

test("renders protected all-publisher, eight-compositor secrets with no production control plane", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-rehearsal-secrets-"));
  const target = join(root, "rendered");
  const material = completeAgentSecrets(createRehearsalSecretMaterial({ random: deterministic }), manifest, { random: deterministic });
  const destinations = Array.from({ length: 8 }, (_, index) => ({
    court: index + 1,
    mode: "persistent-youtube-stream-ingest-v1",
    streamId: `stream-${index + 1}`,
    title: `ScoreCheck Production Camera ${index + 1} Auto Stream`,
    isReusable: true,
    streamName: `secret-key-${index + 1}`,
    rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2",
    rtmpsBackupIngestionAddress: "rtmps://b.rtmps.youtube.com/live2"
  }));
  await renderRehearsalSecretDirectory({
    manifest,
    material,
    directory: target,
    renderer,
    youtubeDestinations: destinations
  });
  const ingest = await readFile(join(target, "ingest.env"), "utf8");
  for (let court = 1; court <= 8; court += 1) {
    assert.match(ingest, new RegExp(`MEDIAMTX_COURT_${court}_RAW_SOURCE="publisher"`));
    assert.match(ingest, new RegExp(`MEDIAMTX_COURT_${court}_BROWSER_SOURCE="raw"`));
  }
  const observer = await readFile(join(target, "observability.env"), "utf8");
  assert.doesNotMatch(observer, /SUPABASE_|HEALTHCHECKS_/);
  const compositor = await readFile(join(target, "compositors", "bvm-compositor-a.env"), "utf8");
  assert.match(compositor, /COURT_1_YOUTUBE_KEY="secret-key-1"/);
  assert.match(compositor, /PROGRAM_PAGE_BASE_URL="https:\/\/scorecheck-rehearsal-abc123-test\.vercel\.app\/program"/);
  assert.match(compositor, /PROGRAM_RENDERER_DEPLOYMENT_ID="dpl_renderer123"/);
  assert.match(compositor, new RegExp(`PROGRAM_RENDERER_GIT_SHA="${"a".repeat(40)}"`));
  assert.match(compositor, /CAMERA_NORMALIZER_ENABLED="false"/);
  assert.match(compositor, /CAMERA_SOURCE_PATH_MODE="direct-h264"/);
  assert.doesNotMatch(compositor, /COURT_2_YOUTUBE_KEY/);
  assert.equal((await stat(join(target, "material.json"))).mode & 0o077, 0);
  await renderRehearsalSecretDirectory({
    manifest,
    material,
    directory: target,
    renderer,
    youtubeDestinations: destinations
  });
  assert.equal((await stat(join(target, "RENDER_COMPLETE.json"))).mode & 0o077, 0);
});

test("rejects production origins and incomplete YouTube ownership", async () => {
  const material = createRehearsalSecretMaterial({ random: deterministic });
  assert.throws(() => buildRehearsalVercelEnvironment({ manifest, material, programOrigin: "https://score.beachvolleyballmedia.com" }), /isolated HTTPS origin/);
  const root = await mkdtemp(join(tmpdir(), "scorecheck-rehearsal-bad-"));
  await assert.rejects(() => renderRehearsalSecretDirectory({ manifest, material, directory: root, renderer, youtubeDestinations: [] }), /exactly eight/);
  await assert.rejects(() => renderRehearsalSecretDirectory({
    manifest,
    material,
    directory: root,
    renderer: { ...renderer, origin: "https://score.beachvolleyballmedia.com" },
    youtubeDestinations: []
  }), /isolated HTTPS origin/);
});
