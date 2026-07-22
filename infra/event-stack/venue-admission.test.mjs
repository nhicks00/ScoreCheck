import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSyntheticRehearsalVenueProfile,
  evaluateVenueAdmission,
  loadVenueAdmission,
  validateVenueProfile
} from "./venue-admission.mjs";

test("admits eight standard 1080p30 cameras only with 30 percent bonded-upload reserve", () => {
  const profile = createSyntheticRehearsalVenueProfile("venue-gate");
  const result = evaluateVenueAdmission(profile);
  assert.equal(result.passed, true);
  assert.deepEqual(result.activeCameras, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(result.aggregateMaximumSourceBitrateBps, 64_000_000);
  assert.equal(result.requiredSustainedUploadMbps, 83.2);
  assert.equal(result.requiredSustainedUploadMbpsRounded, 84);
  profile.uploadMeasurement.sustainedUploadMbps = 83.1;
  assert.equal(evaluateVenueAdmission(profile).passed, false);
});

test("rejects stale or future-dated venue evidence", () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const stale = createSyntheticRehearsalVenueProfile("stale-venue", now);
  stale.uploadMeasurement.measuredAt = "2026-07-20T11:59:59.999Z";
  assert.match(evaluateVenueAdmission(stale, now.getTime()).problems.join("; "), /older than 24 hours/u);

  const future = createSyntheticRehearsalVenueProfile("future-venue", now);
  future.physicalReadiness.assessedAt = "2026-07-21T12:05:00.001Z";
  assert.match(evaluateVenueAdmission(future, now.getTime()).problems.join("; "), /more than five minutes in the future/u);
});

test("keeps permanent identities while allowing an event-specific active camera set", () => {
  const profile = createSyntheticRehearsalVenueProfile("six-camera-event");
  profile.cameras[0] = {
    ...profile.cameras[0],
    cameraModel: "AVKANS Go",
    cameraFirmware: "v2.7.1",
    sourcePathMode: "isolated-hevc-normalizer",
    sourceCodec: "H265",
    sourceProfile: "CONSTRAINED_1080P30",
    sourceRateCapMbps: 6
  };
  profile.cameras[6] = { cameraNumber: 7, cameraIdentity: "camera-7", publishPath: "court7_raw", enabled: false };
  profile.cameras[7] = { cameraNumber: 8, cameraIdentity: "camera-8", publishPath: "court8_raw", enabled: false };
  profile.uploadMeasurement.sustainedUploadMbps = 60;
  const result = evaluateVenueAdmission(profile);
  assert.deepEqual(result.activeCameras, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(result.inactiveCameras, [7, 8]);
  assert.equal(result.assignments[1].sourceCodec, "H265");
  assert.equal(result.assignments[1].outputProfile, "1080p30");
  assert.equal(result.passed, true);
});

test("rejects direct HEVC, H264 on a normalizer path, and unapproved plaintext RTMP", () => {
  const directHevc = createSyntheticRehearsalVenueProfile("direct-hevc");
  directHevc.cameras[0].sourceCodec = "H265";
  assert.throws(() => validateVenueProfile(directHevc), /requires H264/);

  const normalizedH264 = createSyntheticRehearsalVenueProfile("normalized-h264");
  normalizedH264.cameras[0].sourcePathMode = "isolated-hevc-normalizer";
  assert.throws(() => validateVenueProfile(normalizedH264), /requires H265/);

  const plaintext = createSyntheticRehearsalVenueProfile("plaintext-rtmp");
  plaintext.cameras[0].sourceProtocol = "RTMP_LEGACY_APPROVED";
  assert.throws(() => validateVenueProfile(plaintext), /legacy transport approval/);
  plaintext.cameras[0].legacyTransportApproved = true;
  assert.doesNotThrow(() => validateVenueProfile(plaintext));
});

test("rejects missing venue isolation, rate caps, thermal headroom, and protected power", () => {
  const profile = createSyntheticRehearsalVenueProfile("physical-readiness");
  profile.physicalReadiness.cameraNetworkIsolated = false;
  assert.throws(() => validateVenueProfile(profile), /cameraNetworkIsolated/u);
  profile.physicalReadiness.cameraNetworkIsolated = true;
  profile.physicalReadiness.routerTemperatureC = 80;
  assert.throws(() => validateVenueProfile(profile), /thermal/u);
  profile.physicalReadiness.routerTemperatureC = 35;
  profile.cameras[0].sourceRateCapMbps = 25;
  assert.throws(() => validateVenueProfile(profile), /rate cap/u);
  profile.cameras[0].sourceRateCapMbps = 8;
  profile.cameras[0].powerProtected = false;
  assert.throws(() => validateVenueProfile(profile), /power is not protected/u);
});

test("loads only a protected profile bound to the expected event", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-venue-"));
  const path = join(root, "venue.json");
  await writeFile(path, `${JSON.stringify(createSyntheticRehearsalVenueProfile("protected-event"), null, 2)}\n`, { mode: 0o600 });
  const loaded = await loadVenueAdmission(path, "protected-event");
  assert.equal(loaded.passed, true);
  assert.match(loaded.sha256, /^[a-f0-9]{64}$/u);
  await assert.rejects(() => loadVenueAdmission(path, "other-event"), /different event/);
  await chmod(path, 0o644);
  await assert.rejects(() => loadVenueAdmission(path, "protected-event"), /protected file/);
});
