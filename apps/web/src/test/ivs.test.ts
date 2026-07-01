import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { signIvsPlaybackToken } from "../lib/ivs";

describe("IVS token signing", () => {
  it("signs the expected private playback payload", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" });
    const privatePem = privateKey.export({ type: "sec1", format: "pem" }).toString();
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const token = signIvsPlaybackToken({
      channelArn: "arn:aws:ivs:us-west-2:123:channel/example",
      origin: "https://score.beachvolleyballmedia.com",
      viewerId: "session-1",
      privateKey: privatePem,
      expiresInSeconds: 60
    });
    const decoded = jwt.verify(token, publicPem, { algorithms: ["ES384"] }) as Record<string, unknown>;
    expect(decoded["aws:channel-arn"]).toBe("arn:aws:ivs:us-west-2:123:channel/example");
    expect(decoded["aws:viewer-id"]).toBe("session-1");
  });
});
