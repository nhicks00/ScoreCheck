import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCommentaryClientConfig, CommentaryClientManager } from "./commentary-runtime.mjs";
import { createRehearsalSecretMaterial } from "./rehearsal-secrets.mjs";

const material = createRehearsalSecretMaterial({ random: (length) => Buffer.alloc(length, 4) });

test("keeps browser login and page credentials in a protected config outside evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-commentary-config-"));
  const evidence = join(root, "evidence");
  const runtime = join(root, "secrets", "runtime");
  const config = buildCommentaryClientConfig({ court: 4, generationId: "generation-1234", material, programOrigin: "https://isolated.example.com", evidenceDirectory: evidence, runtimeDirectory: runtime });
  assert.equal(config.marker, "scorecheck-rehearsal-generation-1234-commentator-4");
  assert.equal(config.configPath.startsWith(runtime), true);
  assert.equal(config.logPath.startsWith(evidence), true);
  assert.equal(JSON.stringify(config.redacted).includes(material.programPageToken), false);
  assert.equal(JSON.stringify(config.redacted).includes(material.commentatorPasscode), false);
});

test("preflights, starts, adopts, and stops the exact commentary browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-commentary-runtime-"));
  const evidence = join(root, "evidence");
  const runtime = join(root, "secrets", "runtime");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(evidence), mkdir(runtime, { recursive: true })]));
  const config = buildCommentaryClientConfig({ court: 1, generationId: "generation-1234", material, programOrigin: "https://isolated.example.com", evidenceDirectory: evidence, runtimeDirectory: runtime });
  let processLines = "800 unrelated";
  const signals = [];
  let unrefCount = 0;
  const manager = new CommentaryClientManager({
    sleep: async () => {},
    runner: async (command, args) => {
      if (command === "ps") return { code: 0, stdout: processLines, stderr: "" };
      if (args.includes("-encoders")) return { code: 0, stdout: "pcm_s16le", stderr: "" };
      if (args.includes("--version")) return { code: 0, stdout: "v24.0.0", stderr: "" };
      if (args.includes("--preflight")) return { code: 0, stdout: "playwright chromium ready", stderr: "" };
      if (command === "ffmpeg") { await writeFile(config.fixturePath, "fixture", { mode: 0o600 }); return { code: 0, stdout: "", stderr: "" }; }
      throw new Error(`unexpected ${command}`);
    },
    spawnImpl: (_command, args) => {
      assert.equal(args.includes(material.programPageToken), false);
      assert.equal(args.includes(material.commentatorPasscode), false);
      processLines += `\n500 node ${args.join(" ")}`;
      void writeFile(config.readyPath, `${JSON.stringify({ schemaVersion: 1, court: 1, marker: config.marker })}\n`, { mode: 0o600 });
      return { pid: 500, unref: () => { unrefCount += 1; } };
    },
    killImpl: (pid, signal) => { signals.push({ pid, signal }); processLines = processLines.split("\n").filter((line) => !line.startsWith("500 ")).join("\n"); }
  });
  await manager.preflight(config);
  assert.equal((await manager.ensure(config)).pid, 500);
  assert.equal(unrefCount, 1);
  assert.equal((await stat(config.configPath)).mode & 0o077, 0);
  const protectedConfig = await readFile(config.configPath, "utf8");
  assert.match(protectedConfig, new RegExp(material.commentatorPasscode));
  assert.equal((await manager.ensure(config)).adopted, true);
  await manager.stop({ marker: config.marker });
  assert.deepEqual(signals, [{ pid: -500, signal: "SIGTERM" }]);
  assert.match(processLines, /unrelated/);
});
