import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCommentaryClientConfig, CommentaryClientManager } from "./commentary-runtime.mjs";
import { createRehearsalSecretMaterial } from "./rehearsal-secrets.mjs";

const material = createRehearsalSecretMaterial({ random: (length) => Buffer.alloc(length, 4) });

test("keeps LiveKit credentials out of process arguments and redacted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-commentary-config-"));
  const config = buildCommentaryClientConfig({ court: 4, generationId: "generation-1234", material, rtcHost: "rtc-test.example.com", evidenceDirectory: directory });
  assert.equal(config.marker, "scorecheck-rehearsal-generation-1234-commentator-4");
  assert.equal(JSON.stringify(config.redacted).includes(material.commentary.apiSecret), false);
  assert.equal(config.environment.LIVEKIT_API_SECRET, material.commentary.apiSecret);
});

test("starts, adopts, and stops the exact commentary participant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-commentary-runtime-"));
  const config = buildCommentaryClientConfig({ court: 1, generationId: "generation-1234", material, rtcHost: "rtc-test.example.com", evidenceDirectory: directory });
  let processLines = "800 unrelated";
  const signals = [];
  const manager = new CommentaryClientManager({
    sleep: async () => {},
    runner: async (command, args) => {
      if (command === "ps") return { code: 0, stdout: processLines, stderr: "" };
      if (args.includes("-encoders")) return { code: 0, stdout: "libopus", stderr: "" };
      if (args.includes("--version")) return { code: 0, stdout: "lk version 2", stderr: "" };
      if (command === "ffmpeg") { await (await import("node:fs/promises")).writeFile(config.fixturePath, "fixture", { mode: 0o600 }); return { code: 0, stdout: "", stderr: "" }; }
      throw new Error(`unexpected ${command}`);
    },
    spawnImpl: (_command, args, options) => {
      assert.equal(args.includes(material.commentary.apiSecret), false);
      assert.equal(options.env.LIVEKIT_API_SECRET, material.commentary.apiSecret);
      processLines += `\n500 lk ${args.join(" ")}`;
      return { pid: 500 };
    },
    killImpl: (pid, signal) => { signals.push({ pid, signal }); processLines = processLines.split("\n").filter((line) => !line.startsWith("500 ")).join("\n"); }
  });
  await manager.preflight(config);
  assert.equal((await manager.ensure(config)).pid, 500);
  assert.equal((await manager.ensure(config)).adopted, true);
  await manager.stop({ marker: config.marker });
  assert.deepEqual(signals, [{ pid: -500, signal: "SIGTERM" }]);
  assert.match(processLines, /unrelated/);
});
