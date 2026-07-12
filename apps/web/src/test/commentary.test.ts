import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkCommentaryPasscode,
  commentaryLiveKitConfigured,
  commentaryPortalEnabled,
  commentaryRoomName,
  COMMENTARY_COOKIE,
  COMMENTARY_SESSION_MS,
  createCommentaryConnection,
  signCommentaryCookie,
  verifyCommentaryCookie
} from "../lib/commentary";

const COMMENTARY_ENV_KEYS = [
  "COMMENTATOR_PASSCODE",
  "NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL",
  "LIVEKIT_COMMENTARY_API_KEY",
  "LIVEKIT_COMMENTARY_API_SECRET",
  "LIVEKIT_COMMENTARY_ROOM_PREFIX"
];

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of COMMENTARY_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of COMMENTARY_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("LiveKit commentary rooms", () => {
  it("uses stable court-scoped room names", () => {
    expect(commentaryRoomName(1)).toBe("scorecheck-court-1");
    process.env.LIVEKIT_COMMENTARY_ROOM_PREFIX = "bvm-test-";
    expect(commentaryRoomName(8)).toBe("bvm-test-8");
    expect(() => commentaryRoomName(9)).toThrow();
  });

  it("fails closed unless URL and both API credentials exist", () => {
    expect(commentaryLiveKitConfigured()).toBe(false);
    process.env.NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL = "wss://rtc.example.com";
    process.env.LIVEKIT_COMMENTARY_API_KEY = "key";
    expect(commentaryLiveKitConfigured()).toBe(false);
    process.env.LIVEKIT_COMMENTARY_API_SECRET = "secret-secret-secret-secret-1234";
    expect(commentaryLiveKitConfigured()).toBe(true);
    process.env.NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL = "http://rtc.example.com";
    expect(commentaryLiveKitConfigured()).toBe(false);
  });

  it("mints media-capable commentator and data-only program publish grants", async () => {
    configureLiveKit();
    const commentator = await createCommentaryConnection({ courtNumber: 3, displayName: "  Alex Caller  ", role: "commentator" });
    const program = await createCommentaryConnection({ courtNumber: 3, displayName: "", role: "program" });
    const commentatorClaims = jwtPayload(commentator.token);
    const programClaims = jwtPayload(program.token);
    expect(commentator.serverUrl).toBe("wss://rtc.example.com");
    expect(commentator.roomName).toBe("scorecheck-court-3");
    expect(commentatorClaims.name).toBe("Alex Caller");
    expect(commentatorClaims.video).toMatchObject({ room: "scorecheck-court-3", roomJoin: true, canPublish: true, canSubscribe: true });
    expect(programClaims.video).toMatchObject({
      room: "scorecheck-court-3",
      roomJoin: true,
      canPublish: false,
      canPublishData: true,
      canSubscribe: true
    });
  });
});

describe("commentary cookie", () => {
  const secret = "test-admin-secret";

  it("uses a distinct cookie name and round-trips while fresh", () => {
    expect(COMMENTARY_COOKIE).toBe("scorecheck_commentary");
    const now = Date.now();
    const value = signCommentaryCookie(secret, now + COMMENTARY_SESSION_MS);
    expect(verifyCommentaryCookie(value, secret, now)).toBe(true);
  });

  it("rejects expired, tampered, malformed, and wrong-secret cookies", () => {
    const now = Date.now();
    const expired = signCommentaryCookie(secret, now - 1);
    const fresh = signCommentaryCookie(secret, now + 60_000);
    const [version, expiry, signature] = fresh.split(".");
    expect(verifyCommentaryCookie(expired, secret, now)).toBe(false);
    expect(verifyCommentaryCookie([version, String(Number(expiry) + 1), signature].join("."), secret, now)).toBe(false);
    expect(verifyCommentaryCookie(fresh, "wrong", now)).toBe(false);
    expect(verifyCommentaryCookie("not.a.cookie", secret, now)).toBe(false);
    expect(verifyCommentaryCookie(null, secret, now)).toBe(false);
  });
});

describe("commentary passcode", () => {
  it("is disabled when unset and accepts only the configured passcode", () => {
    expect(commentaryPortalEnabled()).toBe(false);
    expect(checkCommentaryPasscode("anything")).toBe(false);
    process.env.COMMENTATOR_PASSCODE = "sideout-2026";
    expect(commentaryPortalEnabled()).toBe(true);
    expect(checkCommentaryPasscode(" sideout-2026 ")).toBe(true);
    expect(checkCommentaryPasscode("sideout-2027")).toBe(false);
  });
});

function configureLiveKit() {
  process.env.NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL = "wss://rtc.example.com";
  process.env.LIVEKIT_COMMENTARY_API_KEY = "test-key";
  process.env.LIVEKIT_COMMENTARY_API_SECRET = "secret-secret-secret-secret-1234";
}

function jwtPayload(token: string): Record<string, any> {
  const payload = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}
