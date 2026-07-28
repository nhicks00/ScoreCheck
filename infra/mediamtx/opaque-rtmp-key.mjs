import { createHash } from "node:crypto";

const KEY_PATTERN = /^sc[1-8]-[A-Za-z0-9_-]{43}$/u;

export function deriveOpaqueRtmpKey({ court, user, password }) {
  if (!Number.isInteger(court) || court < 1 || court > 8) throw new Error("RTMP camera number must be 1-8.");
  if (typeof user !== "string" || !user || typeof password !== "string" || !password) {
    throw new Error(`Camera ${court} RTMP publisher credential is incomplete.`);
  }
  const digest = createHash("sha256")
    .update(`scorecheck-rtmp-path-v1\0${court}\0${user}\0${password}`, "utf8")
    .digest("base64url");
  return `sc${court}-${digest}`;
}

export function opaqueRtmpKey(value, court) {
  if (!KEY_PATTERN.test(value ?? "") || value[2] !== String(court)) {
    throw new Error(`MEDIAMTX_COURT_${court}_RTMP_PUBLISH_KEY must be the derived opaque Camera ${court} key.`);
  }
  return value;
}
