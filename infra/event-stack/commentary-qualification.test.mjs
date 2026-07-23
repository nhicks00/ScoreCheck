import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COMMENTARY_OBSERVATION_SECONDS,
  COMMENTARY_SYNC_TOLERANCE_MS,
  createPendingCommentaryQualification,
  createSyntheticCommentaryQualification,
  evaluateCommentaryQualification,
  loadCommentaryQualification,
  validateCommentaryQualification
} from "./commentary-qualification.mjs";

test("represents pre-provision commentary honestly as pending", () => {
  const value = createPendingCommentaryQualification("commentary-pending", [1, 3]);
  assert.equal(value.status, "PENDING");
  assert.equal(evaluateCommentaryQualification(value, [1, 3]).passed, false);
  assert.deepEqual(value.courts, [{ cameraNumber: 1, status: "PENDING" }, { cameraNumber: 3, status: "PENDING" }]);
});

test("admits an exact physical commentary return, mix-minus, continuity, audio, sync, and TURN/TLS contract", () => {
  const value = createSyntheticCommentaryQualification("commentary-ready", [1, 3]);
  const result = evaluateCommentaryQualification(value, [1, 3]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.problems, []);
  assert.equal(value.turnTls.observationSeconds, COMMENTARY_OBSERVATION_SECONDS);
});

test("rejects failed mix-minus, stale path calibration, short TURN observation, and excessive sync offset", () => {
  const value = createSyntheticCommentaryQualification("commentary-fail", [1]);
  value.turnTls.observationSeconds = COMMENTARY_OBSERVATION_SECONDS - 1;
  value.courts[0].mixMinus.selfMicrophoneAbsent = false;
  value.courts[0].calibration.endOffsetMs = COMMENTARY_SYNC_TOLERANCE_MS + 1;
  value.courts[0].calibration.materialPathChangedAfterCalibration = true;
  const result = evaluateCommentaryQualification(value, [1]);
  assert.equal(result.passed, false);
  assert.match(result.problems.join("\n"), /TURN\/TLS fallback observation was too short/u);
  assert.match(result.problems.join("\n"), /mix-minus/u);
  assert.match(result.problems.join("\n"), /exceeded 250 ms/u);
  assert.match(result.problems.join("\n"), /path changed/u);
});

test("requires exactly the active cameras and an exact preview return path", () => {
  const missing = createSyntheticCommentaryQualification("commentary-cameras", [1, 2]);
  missing.courts.pop();
  assert.throws(() => validateCommentaryQualification(missing, "commentary-cameras", [1, 2]), /active cameras/u);

  const wrongPath = createSyntheticCommentaryQualification("commentary-path", [2]);
  wrongPath.courts[0].returnFeed.path = "court1_preview";
  assert.throws(() => validateCommentaryQualification(wrongPath, "commentary-path", [2]), /return path/u);
});

test("loads only a mode-0600 qualification bound to the event", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-commentary-"));
  const path = join(root, "commentary.json");
  await writeFile(path, `${JSON.stringify(createSyntheticCommentaryQualification("commentary-protected", [1]))}\n`, { mode: 0o600 });
  const loaded = await loadCommentaryQualification(path, "commentary-protected", [1]);
  assert.equal(loaded.passed, true);
  assert.match(loaded.sha256, /^[a-f0-9]{64}$/u);
  await assert.rejects(() => loadCommentaryQualification(path, "another-event", [1]), /different event/u);
  await chmod(path, 0o644);
  await assert.rejects(() => loadCommentaryQualification(path, "commentary-protected", [1]), /protected file/u);
});

test("requires installed commentary evidence from the current lifecycle generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-commentary-generation-"));
  const path = join(root, "commentary.json");
  const qualification = createSyntheticCommentaryQualification("commentary-generation", [1]);
  qualification.installation = {
    installedAt: "2026-07-23T14:00:00.000Z",
    lifecycleGenerationId: "generation-12345678",
    sourceSha256: "a".repeat(64)
  };
  await writeFile(path, `${JSON.stringify(qualification)}\n`, { mode: 0o600 });

  const loaded = await loadCommentaryQualification(path, "commentary-generation", [1], {
    requireInstalled: true,
    lifecycleGenerationId: "generation-12345678"
  });
  assert.equal(loaded.passed, true);
  await assert.rejects(() => loadCommentaryQualification(path, "commentary-generation", [1], {
    requireInstalled: true,
    lifecycleGenerationId: "generation-different"
  }), /different lifecycle generation/u);
});
