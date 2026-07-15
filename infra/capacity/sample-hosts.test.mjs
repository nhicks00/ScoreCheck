import assert from "node:assert/strict";
import test from "node:test";

import { parseRemoteSample } from "./sample-hosts.mjs";

test("parses bounded credential-free remote samples", () => {
  assert.deepEqual(parseRemoteSample("0.251000,1,0.125000\n"), {
    cpuRatio: 0.251,
    zombies: 1,
    shmRatio: 0.125
  });
});

test("rejects malformed remote samples", () => {
  assert.throws(() => parseRemoteSample("secret=value"), /three fields/);
  assert.throws(() => parseRemoteSample("2,0,0"), /CPU ratio/);
  assert.throws(() => parseRemoteSample("0.2,1.5,0"), /zombie count/);
  assert.throws(() => parseRemoteSample("0.2,0,2"), /shared-memory ratio/);
});
