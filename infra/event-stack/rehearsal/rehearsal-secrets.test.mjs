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

test("generates isolated Vercel configuration without Supabase", () => {
  const material = createRehearsalSecretMaterial({ random: deterministic });
  const environment = buildRehearsalVercelEnvironment({ manifest, material, programOrigin: "https://scorecheck-rehearsal-test.vercel.app" });
  assert.equal(environment.MEDIAMTX_WHEP_BASE_URL, `https://${manifest.endpoints.find((entry) => entry.role === "ingest").hostname}`);
  assert.equal(Object.keys(environment).some((key) => key.startsWith("SUPABASE_")), false);
  assert.equal(environment.SCORECHECK_REHEARSAL_ORIGIN, "https://scorecheck-rehearsal-test.vercel.app");
});

test("renders protected all-publisher, eight-compositor secrets with no production control plane", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-rehearsal-secrets-"));
  const target = join(root, "rendered");
  const material = completeAgentSecrets(createRehearsalSecretMaterial({ random: deterministic }), manifest, { random: deterministic });
  const destinations = Array.from({ length: 8 }, (_, index) => ({
    court: index + 1,
    streamId: `stream-${index + 1}`,
    broadcastId: `broadcast-${index + 1}`,
    streamName: `secret-key-${index + 1}`,
    rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2"
  }));
  await renderRehearsalSecretDirectory({
    manifest,
    material,
    directory: target,
    programOrigin: "https://scorecheck-rehearsal-test.vercel.app",
    youtubeDestinations: destinations
  });
  const ingest = await readFile(join(target, "ingest.env"), "utf8");
  for (let court = 1; court <= 8; court += 1) assert.match(ingest, new RegExp(`MEDIAMTX_COURT_${court}_RAW_SOURCE="publisher"`));
  const observer = await readFile(join(target, "observability.env"), "utf8");
  assert.doesNotMatch(observer, /SUPABASE_|HEALTHCHECKS_/);
  const compositor = await readFile(join(target, "compositors", "bvm-compositor-a.env"), "utf8");
  assert.match(compositor, /COURT_1_YOUTUBE_KEY="secret-key-1"/);
  assert.doesNotMatch(compositor, /COURT_2_YOUTUBE_KEY/);
  assert.equal((await stat(join(target, "material.json"))).mode & 0o077, 0);
  await renderRehearsalSecretDirectory({
    manifest,
    material,
    directory: target,
    programOrigin: "https://scorecheck-rehearsal-test.vercel.app",
    youtubeDestinations: destinations
  });
  assert.equal((await stat(join(target, "RENDER_COMPLETE.json"))).mode & 0o077, 0);
});

test("rejects production origins and incomplete YouTube ownership", async () => {
  const material = createRehearsalSecretMaterial({ random: deterministic });
  assert.throws(() => buildRehearsalVercelEnvironment({ manifest, material, programOrigin: "https://score.beachvolleyballmedia.com" }), /isolated HTTPS origin/);
  const root = await mkdtemp(join(tmpdir(), "scorecheck-rehearsal-bad-"));
  await assert.rejects(() => renderRehearsalSecretDirectory({ manifest, material, directory: root, programOrigin: "https://isolated.vercel.app", youtubeDestinations: [] }), /exactly eight/);
});
