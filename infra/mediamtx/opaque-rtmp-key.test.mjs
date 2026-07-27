import assert from "node:assert/strict";
import test from "node:test";

import { deriveOpaqueRtmpKey, opaqueRtmpKey } from "./opaque-rtmp-key.mjs";

test("derives stable camera-scoped query-free RTMP keys", () => {
  const input = { court: 3, user: "camera-three", password: "protected-password" };
  const key = deriveOpaqueRtmpKey(input);
  assert.match(key, /^sc3-[A-Za-z0-9_-]{43}$/u);
  assert.equal(deriveOpaqueRtmpKey(input), key);
  assert.notEqual(deriveOpaqueRtmpKey({ ...input, court: 4 }), key);
  assert.equal(opaqueRtmpKey(key, 3), key);
});

test("rejects malformed, cross-camera, or incomplete RTMP keys", () => {
  assert.throws(() => opaqueRtmpKey("camera3test", 3), /derived opaque/u);
  assert.throws(() => opaqueRtmpKey(`sc4-${"a".repeat(43)}`, 3), /Camera 3/u);
  assert.throws(() => deriveOpaqueRtmpKey({ court: 3, user: "", password: "password" }), /incomplete/u);
});
