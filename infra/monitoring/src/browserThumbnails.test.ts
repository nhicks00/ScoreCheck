import { describe, expect, it } from "vitest";
import { signCredentialForTest } from "./browserHeartbeats.js";
import { BrowserThumbnailManager } from "./browserThumbnails.js";

const secret = "thumbnail-test-secret-that-is-at-least-32-characters";
const credentialId = "d79db364-9ece-4979-8dc4-197c4daa8e73";
const now = new Date("2026-07-12T12:00:00Z");
const token = signCredentialForTest({
  secret,
  credentialId,
  courtNumber: 2,
  issuedAtMs: now.getTime() - 1_000,
  expiresAtMs: now.getTime() + 60_000
});
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300)]);

describe("browser thumbnail manager", () => {
  it("accepts a scoped JPEG and rejects replay", () => {
    const manager = new BrowserThumbnailManager(secret);
    const headers = { credentialId, courtNumber: "2", sequence: "1", sampledAt: now.toISOString() };
    expect(manager.accept(token, headers, jpeg, now)).toMatchObject({ courtNumber: 2, byteLength: jpeg.length });
    expect(manager.metadata().get(2)).not.toHaveProperty("body");
    expect(() => manager.accept(token, headers, jpeg, now)).toThrow("replayed");
  });

  it("rejects a credential scoped to another court and non-JPEG data", () => {
    const manager = new BrowserThumbnailManager(secret);
    expect(() => manager.accept(token, { credentialId, courtNumber: "1", sequence: "1", sampledAt: now.toISOString() }, jpeg, now)).toThrow("scope");
    expect(() => manager.accept(token, { credentialId, courtNumber: "2", sequence: "1", sampledAt: now.toISOString() }, Buffer.alloc(300), now)).toThrow("JPEG");
  });
});
