import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, requireTierOneCamera } from "./youtube-backupctl.mjs";

test("requires protected inputs and an exact camera-scoped confirmation", () => {
  const options = parseArgs([
    "run",
    "--profile", "/protected/profile.json",
    "--destinations", "/protected/destinations.json",
    "--soak-evidence", "/protected/soak",
    "--evidence", "/protected/backup",
    "--camera", "1",
    "--confirm", "YOUTUBE-BACKUP:event:generation:CAMERA-1"
  ]);
  assert.equal(options.command, "run");
  assert.equal(options.camera, 1);
  assert.equal(options.confirm, "YOUTUBE-BACKUP:event:generation:CAMERA-1");
  assert.throws(() => parseArgs(["run", "--evidence", "/protected/backup"]), /profile must be a normalized absolute path/u);
  assert.throws(() => parseArgs(["run", "--profile", "/protected/profile.json", "--destinations", "/protected/destinations.json", "--soak-evidence", "/protected/soak", "--evidence", "/protected/backup", "--camera", "9", "--confirm", "yes"]), /camera must be from 1 through 8/u);
});

test("admits YouTube backup only for an explicitly Tier 1 camera", () => {
  const venue = { assignments: { 1: { priorityTier: "TIER_1" }, 2: { priorityTier: "TIER_2" } } };
  assert.equal(requireTierOneCamera(venue, 1).priorityTier, "TIER_1");
  assert.throws(() => requireTierOneCamera(venue, 2), /not a Tier 1/u);
  assert.throws(() => requireTierOneCamera(venue, 3), /not a Tier 1/u);
});

test("status is read-only and requires only its protected evidence directory", () => {
  assert.deepEqual(parseArgs(["status", "--evidence", "/protected/backup"]), {
    command: "status",
    profile: null,
    destinations: null,
    soakEvidence: null,
    evidence: "/protected/backup",
    camera: null,
    confirm: null
  });
  assert.equal(parseArgs(["--help"]), null);
});
