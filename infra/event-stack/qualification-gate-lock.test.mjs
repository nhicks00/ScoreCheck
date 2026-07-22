import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withQualificationGateLock } from "./qualification-gate-lock.mjs";

test("serializes disruptive qualification gates for one event generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-qualification-gate-"));
  const context = {
    profile: { state: join(root, "lifecycle-state.json") },
    lifecycleState: { event: "qualification-event", generationId: "generation-1234" }
  };
  let overlappingGateRan = false;

  await withQualificationGateLock({ ...context, gate: "renderer loss" }, async () => {
    await assert.rejects(
      () => withQualificationGateLock({ ...context, gate: "Supabase loss" }, async () => { overlappingGateRan = true; }),
      /qualification-gate\.lock/u
    );
    const owner = JSON.parse(await readFile(`${context.profile.state}.qualification-gate.lock`, "utf8"));
    assert.equal(owner.pid, process.pid);
  });

  assert.equal(overlappingGateRan, false);
  let laterGateRan = false;
  await withQualificationGateLock({ ...context, gate: "ingest recovery" }, async () => { laterGateRan = true; });
  assert.equal(laterGateRan, true);
});

test("rejects incomplete gate identity before creating a lock", async () => {
  assert.throws(
    () => withQualificationGateLock({ profile: { state: "relative.json" }, lifecycleState: {}, gate: "renderer loss" }, async () => {}),
    /absolute lifecycle state path/u
  );
});

test("all disruptive rehearsal CLIs use the shared gate lock", async () => {
  for (const file of [
    "renderer-loss-rehearsal.mjs",
    "supabase-loss-rehearsal.mjs",
    "overlay-exception-rehearsal.mjs",
    "ingest-recovery-rehearsal.mjs"
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /import \{ withQualificationGateLock \} from "\.\/qualification-gate-lock\.mjs";/u, file);
    assert.match(source, /withQualificationGateLock\(/u, file);
  }
});

test("coverage and retirement lifecycle transitions use the shared gate lock", async () => {
  const source = await readFile(new URL("event-stack.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ withQualificationGateLock \} from "\.\/qualification-gate-lock\.mjs";/u);
  for (const command of ["start", "close", "evidence", "destroy", "abort"]) {
    assert.equal(source.includes(`runLifecycleTransition("lifecycle ${command}"`), true, command);
  }
});
