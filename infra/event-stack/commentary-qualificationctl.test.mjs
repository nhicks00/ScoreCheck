import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPendingCommentaryQualification, createSyntheticCommentaryQualification, loadCommentaryQualification } from "./commentary-qualification.mjs";
import { initialize, install } from "./commentary-qualificationctl.mjs";
import { createSyntheticRehearsalVenueProfile } from "./venue-admission.mjs";

test("initializes a protected pending qualification for exact cameras", async () => {
  const root = await protectedDirectory();
  const output = join(root, "pending.json");
  const result = await initialize({ event: "physical-preflight", cameras: [1, 3], output });
  assert.equal(result.status, "PENDING");
  assert.equal((await loadCommentaryQualification(output, "physical-preflight", [1, 3])).passed, false);
});

test("installs one passed physical qualification only on the ready event generation", async () => {
  const fixture = await installFixture();
  const now = () => new Date("2026-07-23T14:00:00.000Z");
  const result = await install(fixture.options, { now });
  assert.equal(result.status, "PASS");
  assert.equal(result.idempotent, false);
  const installed = await loadCommentaryQualification(fixture.profile.commentaryQualification, fixture.event, [1], { requireInstalled: true });
  assert.equal(installed.passed, true);
  assert.equal(installed.qualification.installation.lifecycleGenerationId, fixture.generationId);
  assert.equal(JSON.parse(await readFile(fixture.markerPath, "utf8")).initialCommentaryQualificationSha256, fixture.initialSha256);

  const repeated = await install(fixture.options, { now });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.installedSha256, result.installedSha256);
});

test("rejects installation during coverage, after a soak starts, or with failed observations", async () => {
  const live = await installFixture();
  await writeProtected(live.profile.state, { event: live.event, phase: "live", generationId: live.generationId });
  await assert.rejects(() => install(live.options), /only on its ready production event/u);

  const started = await installFixture();
  await writeProtected(join(started.profile.evidence, "production-soak-state.json"), { phase: "ARMED" });
  await assert.rejects(() => install(started.options), /production soak state already exists/u);

  const failed = await installFixture();
  const candidate = JSON.parse(await readFile(failed.options.candidate, "utf8"));
  candidate.turnTls.connected = false;
  await writeProtected(failed.options.candidate, candidate);
  await assert.rejects(() => install(failed.options), /candidate commentary qualification did not pass/u);

  const conflicting = await installFixture();
  await writeProtected(conflicting.options.receipt, { schemaVersion: 1, status: "FAIL" });
  await assert.rejects(() => install(conflicting.options), /receipt already exists before installation/u);
  assert.equal((await loadCommentaryQualification(conflicting.profile.commentaryQualification, conflicting.event, [1])).qualification.status, "PENDING");
});

async function installFixture() {
  const root = await protectedDirectory();
  const evidence = join(root, "evidence");
  await mkdir(evidence, { mode: 0o700 });
  const event = "physical-commentary";
  const generationId = "generation-12345678";
  const paths = Object.fromEntries(["manifest", "state", "venue", "commentary", "candidate", "profile", "marker", "receipt"].map((name) => [name, join(root, `${name}.json`)]));
  const pending = createPendingCommentaryQualification(event, [1]);
  await writeProtected(paths.commentary, pending);
  const initialSha256 = sha256(await readFile(paths.commentary));
  await writeProtected(paths.manifest, { event, kind: "production" });
  await writeProtected(paths.state, { event, phase: "ready", generationId });
  const venue = createSyntheticRehearsalVenueProfile(event);
  for (const [index, camera] of venue.cameras.entries()) {
    if (camera.cameraNumber !== 1) venue.cameras[index] = {
      cameraNumber: camera.cameraNumber,
      cameraIdentity: camera.cameraIdentity,
      publishPath: camera.publishPath,
      enabled: false
    };
  }
  await writeProtected(paths.venue, venue);
  await writeProtected(paths.candidate, createSyntheticCommentaryQualification(event, [1]));
  const profile = {
    schemaVersion: 9,
    manifest: paths.manifest,
    state: paths.state,
    anchors: join(root, "anchors.json"),
    secrets: join(root, "secrets"),
    sshKey: join(root, "ssh-key"),
    knownHosts: join(root, "known-hosts"),
    commentaryTlsState: join(root, "commentary-tls"),
    ingestTlsState: join(root, "ingest-tls"),
    observabilityTlsState: join(root, "observability-tls"),
    credentialsEnv: join(root, "credentials.env"),
    lifecycleAttestation: join(root, "attestation.json"),
    rendererBinding: null,
    venueProfile: paths.venue,
    commentaryQualification: join(root, "commentary-qualification.json"),
    evidence,
    rehearsalEvidence: null
  };
  await writeProtected(profile.commentaryQualification, pending);
  await writeProtected(paths.profile, profile);
  const markerPath = join(root, "BUNDLE.json");
  await writeProtected(markerPath, { schemaVersion: 2, kind: "production", event, initialCommentaryQualificationSha256: sha256(await readFile(profile.commentaryQualification)) });
  return {
    root, event, generationId, initialSha256: sha256(await readFile(profile.commentaryQualification)), markerPath, profile,
    options: { profile: paths.profile, candidate: paths.candidate, receipt: paths.receipt }
  };
}

async function protectedDirectory() {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-commentary-cutover-"));
  await chmod(root, 0o700);
  return root;
}

async function writeProtected(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
