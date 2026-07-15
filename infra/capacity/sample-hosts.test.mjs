import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("continuous host watcher self-test accepts only exact process signatures", async () => {
  const result = await run("python3", [fileURLToPath(new URL("./watch-zombies.py", import.meta.url)), "--self-test"]);
  assert.equal(result.code, 0, result.stderr);
});

test("host sampler fails closed when required protected outputs are absent", async () => {
  const result = await run(process.execPath, [fileURLToPath(new URL("./sample-hosts.mjs", import.meta.url))]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--ingest-host is required/);
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
