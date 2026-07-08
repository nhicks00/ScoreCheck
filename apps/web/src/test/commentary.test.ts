import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkCommentaryPasscode,
  commentaryPortalEnabled,
  COMMENTARY_COOKIE,
  COMMENTARY_SESSION_MS,
  signCommentaryCookie,
  vdoDirectorUrl,
  vdoGuestRelayUrl,
  vdoGuestUrl,
  vdoRoomName,
  vdoSceneBufferMs,
  vdoSceneUrl,
  verifyCommentaryCookie
} from "../lib/commentary";

const COMMENTARY_ENV_KEYS = ["VDO_ROOM_PREFIX", "VDO_ROOM_PASSWORD", "VDO_SCENE_BUFFER_MS", "COMMENTATOR_PASSCODE"];

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
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("vdoRoomName", () => {
  it("defaults to BVMCOURT{n}", () => {
    expect(vdoRoomName(3)).toBe("BVMCOURT3");
    expect(vdoRoomName(8)).toBe("BVMCOURT8");
  });

  it("honours the VDO_ROOM_PREFIX override", () => {
    process.env.VDO_ROOM_PREFIX = "AVPDEN";
    expect(vdoRoomName(2)).toBe("AVPDEN2");
  });

  it("falls back to the default prefix when the override is blank", () => {
    process.env.VDO_ROOM_PREFIX = "   ";
    expect(vdoRoomName(1)).toBe("BVMCOURT1");
  });
});

describe("vdoGuestUrl", () => {
  it("builds the exact guest URL", () => {
    expect(vdoGuestUrl(3)).toBe(
      "https://vdo.ninja/?room=BVMCOURT3&password=bvm2026&miconly&labelsuggestion=Stream%203%20Commentator&oab=80&noisegate"
    );
  });

  it("encodes overridden passwords strictly (RFC 3986, ! as %21)", () => {
    process.env.VDO_ROOM_PASSWORD = "p@ss !word(1)*";
    expect(vdoGuestUrl(1)).toContain("password=p%40ss%20%21word%281%29%2A&");
  });

  it("uses the overridden room prefix", () => {
    process.env.VDO_ROOM_PREFIX = "AVPDEN";
    expect(vdoGuestUrl(5)).toContain("?room=AVPDEN5&");
    expect(vdoGuestUrl(5)).toContain("labelsuggestion=Stream%205%20Commentator");
  });
});

describe("vdoGuestRelayUrl", () => {
  it("is the guest URL plus the TURN relay flag", () => {
    expect(vdoGuestRelayUrl(3)).toBe(`${vdoGuestUrl(3)}&relay`);
    expect(vdoGuestRelayUrl(3)).toBe(
      "https://vdo.ninja/?room=BVMCOURT3&password=bvm2026&miconly&labelsuggestion=Stream%203%20Commentator&oab=80&noisegate&relay"
    );
  });
});

describe("vdoDirectorUrl", () => {
  it("builds the exact director URL with the eight-room switch chain", () => {
    expect(vdoDirectorUrl(3)).toBe(
      "https://vdo.ninja/?director&room=BVMCOURT3&password=bvm2026&previewmode&showconnections&notify" +
      "&rooms=BVMCOURT1,BVMCOURT2,BVMCOURT3,BVMCOURT4,BVMCOURT5,BVMCOURT6,BVMCOURT7,BVMCOURT8"
    );
  });

  it("builds the rooms chain from the overridden prefix", () => {
    process.env.VDO_ROOM_PREFIX = "AVPDEN";
    expect(vdoDirectorUrl(1)).toContain(
      "&rooms=AVPDEN1,AVPDEN2,AVPDEN3,AVPDEN4,AVPDEN5,AVPDEN6,AVPDEN7,AVPDEN8"
    );
  });
});

describe("vdoSceneUrl", () => {
  it("builds the exact audio-only scene URL for the StreamRun overlay", () => {
    expect(vdoSceneUrl(3)).toBe(
      "https://vdo.ninja/?scene&room=BVMCOURT3&password=bvm2026&novideo&audiobitrate=80&buffer=2000&retry"
    );
  });

  it("uses the configured buffer", () => {
    process.env.VDO_SCENE_BUFFER_MS = "700";
    expect(vdoSceneUrl(1)).toContain("&buffer=700&retry");
  });
});

describe("vdoSceneBufferMs", () => {
  it("defaults to 2000ms when unset or blank", () => {
    expect(vdoSceneBufferMs()).toBe(2000);
    process.env.VDO_SCENE_BUFFER_MS = "   ";
    expect(vdoSceneBufferMs()).toBe(2000);
  });

  it("falls back to the default on non-numeric values", () => {
    process.env.VDO_SCENE_BUFFER_MS = "fast";
    expect(vdoSceneBufferMs()).toBe(2000);
  });

  it("clamps into 0..4000 and rounds to whole milliseconds", () => {
    process.env.VDO_SCENE_BUFFER_MS = "250";
    expect(vdoSceneBufferMs()).toBe(250);
    process.env.VDO_SCENE_BUFFER_MS = "99999";
    expect(vdoSceneBufferMs()).toBe(4000);
    process.env.VDO_SCENE_BUFFER_MS = "-300";
    expect(vdoSceneBufferMs()).toBe(0);
    process.env.VDO_SCENE_BUFFER_MS = "1500.6";
    expect(vdoSceneBufferMs()).toBe(1501);
  });
});

describe("commentary cookie", () => {
  const secret = "test-admin-secret";

  it("uses a distinct cookie name from the admin cookie", () => {
    expect(COMMENTARY_COOKIE).toBe("scorecheck_commentary");
  });

  it("round-trips sign/verify while the cookie is fresh", () => {
    const now = Date.now();
    const value = signCommentaryCookie(secret, now + COMMENTARY_SESSION_MS);
    expect(verifyCommentaryCookie(value, secret, now)).toBe(true);
  });

  it("rejects an expired cookie", () => {
    const now = Date.now();
    const value = signCommentaryCookie(secret, now - 1);
    expect(verifyCommentaryCookie(value, secret, now)).toBe(false);
  });

  it("rejects a cookie signed with a different secret", () => {
    const now = Date.now();
    const value = signCommentaryCookie("some-other-secret", now + 60_000);
    expect(verifyCommentaryCookie(value, secret, now)).toBe(false);
  });

  it("rejects a cookie whose expiry was tampered with", () => {
    const now = Date.now();
    const value = signCommentaryCookie(secret, now + 60_000);
    const [version, expiry, signature] = value.split(".");
    const tampered = [version, String(Number(expiry) + 86_400_000), signature].join(".");
    expect(verifyCommentaryCookie(tampered, secret, now)).toBe(false);
  });

  it("rejects malformed, empty, and missing values", () => {
    expect(verifyCommentaryCookie("", secret)).toBe(false);
    expect(verifyCommentaryCookie(null, secret)).toBe(false);
    expect(verifyCommentaryCookie(undefined, secret)).toBe(false);
    expect(verifyCommentaryCookie("not.a.cookie", secret)).toBe(false);
    expect(verifyCommentaryCookie("v1.garbage", secret)).toBe(false);
  });

  it("rejects everything when the signing secret is empty", () => {
    const now = Date.now();
    const value = signCommentaryCookie(secret, now + 60_000);
    expect(verifyCommentaryCookie(value, "", now)).toBe(false);
  });
});

describe("commentary passcode", () => {
  it("treats an unset or blank passcode as portal disabled", () => {
    expect(commentaryPortalEnabled()).toBe(false);
    expect(checkCommentaryPasscode("anything")).toBe(false);

    process.env.COMMENTATOR_PASSCODE = "   ";
    expect(commentaryPortalEnabled()).toBe(false);
    expect(checkCommentaryPasscode("   ")).toBe(false);
    expect(checkCommentaryPasscode("")).toBe(false);
  });

  it("accepts only the exact configured passcode", () => {
    process.env.COMMENTATOR_PASSCODE = "sideout-2026";
    expect(commentaryPortalEnabled()).toBe(true);
    expect(checkCommentaryPasscode("sideout-2026")).toBe(true);
    expect(checkCommentaryPasscode("sideout-2027")).toBe(false);
    expect(checkCommentaryPasscode("")).toBe(false);
    expect(checkCommentaryPasscode(null)).toBe(false);
    expect(checkCommentaryPasscode(undefined)).toBe(false);
  });

  it("forgives surrounding whitespace from copy/paste", () => {
    process.env.COMMENTATOR_PASSCODE = "sideout-2026";
    expect(checkCommentaryPasscode("  sideout-2026  ")).toBe(true);
  });
});
