import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSyntheticVenueProfile, parseArgs } from "./synthetic-venue-profilectl.mjs";
import { validateVenueProfile } from "./venue-admission.mjs";

test("creates one protected eight-camera synthetic profile bound to its event", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-synthetic-venue-"));
  const output = join(root, "venue-profile.json");
  await chmod(root, 0o700);
  try {
    const result = await createSyntheticVenueProfile({ event: "synthetic-profile-gate", output, now: () => new Date("2026-07-23T14:00:00.000Z") });
    assert.deepEqual(result.activeCameras, [1, 2, 3, 4, 5, 6, 7, 8]);
    const profile = JSON.parse(await readFile(output, "utf8"));
    assert.equal(profile.event, "synthetic-profile-gate");
    assert.equal(validateVenueProfile(profile, "synthetic-profile-gate"), profile);
    await assert.rejects(() => createSyntheticVenueProfile({ event: "synthetic-profile-gate", output }), /EEXIST/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires the exact minimal create invocation", () => {
  assert.deepEqual(parseArgs(["create", "--event", "synthetic-profile-gate", "--output", "/protected/venue.json"]), {
    event: "synthetic-profile-gate",
    output: "/protected/venue.json"
  });
  assert.throws(() => parseArgs(["create", "--event", "synthetic-profile-gate"]), /required/);
  assert.throws(() => parseArgs(["other"]), /first argument/);
});
