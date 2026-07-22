import assert from "node:assert/strict";
import test from "node:test";

import { criticalLogLine, roleDirectory, sanitizeCriticalLogLine } from "./critical-log-export.mjs";

test("retains lifecycle and failure lines but ignores ordinary chatter", () => {
  assert.equal(criticalLogLine("egress started output EG_123"), true);
  assert.equal(criticalLogLine("WHEP reader disconnected"), true);
  assert.equal(criticalLogLine("HTTP request completed in 4ms"), false);
});

test("redacts protected media and application credentials", () => {
  const line = "Bearer abc.def rtmps://a.rtmps.youtube.com/live2/private-key#token=secret COURT_1_YOUTUBE_KEY=private {\"api_key\":\"json-secret\"} https://user:pass@example.test/path";
  const sanitized = sanitizeCriticalLogLine(line);
  assert.doesNotMatch(sanitized, /private-key|token=secret|COURT_1_YOUTUBE_KEY=private|json-secret|user:pass/u);
  assert.match(sanitized, /\[REDACTED\]/u);
});

test("maps only the four production host roles to fixed deployment roots", () => {
  assert.equal(roleDirectory("ingest"), "/opt/mediamtx");
  assert.equal(roleDirectory("commentary"), "/opt/livekit");
  assert.equal(roleDirectory("observability"), "/opt/scorecheck-monitoring");
  assert.equal(roleDirectory("compositor-spare"), "/opt/compositor");
  assert.throws(() => roleDirectory("unknown"), /unsupported/u);
});
