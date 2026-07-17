import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withProcessLock } from "./process-lock.mjs";

test("rejects a live owner's lock and never runs the concurrent operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-process-lock-"));
  const path = join(root, "state.lock");
  let concurrentRan = false;
  await withProcessLock({ lockPath: path, label: "test" }, async () => {
    const owner = JSON.parse(await readFile(path, "utf8"));
    assert.equal(owner.pid, process.pid);
    await assert.rejects(
      () => withProcessLock({ lockPath: path, label: "test" }, async () => { concurrentRan = true; }),
      /lock already exists/
    );
  });
  assert.equal(concurrentRan, false);
});

test("reclaims a protected lock only after its recorded local PID is dead", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-process-lock-stale-"));
  const path = join(root, "state.lock");
  await writeFile(path, `${JSON.stringify({ pid: 2_147_483_647, acquiredAt: "2026-07-17T00:00:00.000Z" })}\n`, { mode: 0o600 });
  let ran = false;
  await withProcessLock({ lockPath: path, label: "test" }, async () => { ran = true; });
  assert.equal(ran, true);
  await assert.rejects(() => stat(path), (error) => error?.code === "ENOENT");
});

test("fails closed on malformed lock ownership instead of deleting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-process-lock-invalid-"));
  const path = join(root, "state.lock");
  await writeFile(path, "{}\n", { mode: 0o600 });
  await assert.rejects(() => withProcessLock({ lockPath: path, label: "test" }, async () => {}), /metadata is invalid/);
  assert.equal((await stat(path)).isFile(), true);
});
