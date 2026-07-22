import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  broadcastChipForEgress,
  buildProgramMonitorPath,
  classifyHeartbeatFreshness,
  controllerBaseUrlFromEnv,
  controllerConfiguredFromEnv,
  controllerCourtActionUrl,
  controllerCourtsUrl,
  countFreshHeartbeats,
  egressForCourt,
  isValidCourtNumber,
  maskStreamKey,
  normalizeControllerUrl,
  parseControllerCourts,
  PROGRAM_HEARTBEAT_FRESH_MS,
  youtubeWatchUrl
} from "../lib/opsConsole";

const OPS_ENV_KEYS = ["CONTROLLER_URL", "CONTROLLER_TOKEN"];
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of OPS_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of OPS_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const NOW = Date.parse("2026-07-08T12:00:00Z");

function isoSecondsAgo(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

describe("classifyHeartbeatFreshness", () => {
  it("returns never for missing or unparseable timestamps", () => {
    expect(classifyHeartbeatFreshness(null, NOW)).toBe("never");
    expect(classifyHeartbeatFreshness(undefined, NOW)).toBe("never");
    expect(classifyHeartbeatFreshness("", NOW)).toBe("never");
    expect(classifyHeartbeatFreshness("not-a-date", NOW)).toBe("never");
  });

  it("classifies beats within 15s as fresh, older as stale", () => {
    expect(classifyHeartbeatFreshness(isoSecondsAgo(0), NOW)).toBe("fresh");
    expect(classifyHeartbeatFreshness(isoSecondsAgo(5), NOW)).toBe("fresh");
    expect(classifyHeartbeatFreshness(new Date(NOW - PROGRAM_HEARTBEAT_FRESH_MS), NOW)).toBe("fresh");
    expect(classifyHeartbeatFreshness(new Date(NOW - PROGRAM_HEARTBEAT_FRESH_MS - 1), NOW)).toBe("stale");
    expect(classifyHeartbeatFreshness(isoSecondsAgo(60), NOW)).toBe("stale");
  });

  it("treats small future clock skew as fresh", () => {
    expect(classifyHeartbeatFreshness(isoSecondsAgo(-3), NOW)).toBe("fresh");
  });
});

describe("countFreshHeartbeats", () => {
  it("counts only fresh rows and tolerates empty input", () => {
    expect(countFreshHeartbeats(null, NOW)).toBe(0);
    expect(countFreshHeartbeats(undefined, NOW)).toBe(0);
    expect(countFreshHeartbeats([], NOW)).toBe(0);
    const rows = [
      { last_seen_at: isoSecondsAgo(2) },
      { last_seen_at: isoSecondsAgo(14) },
      { last_seen_at: isoSecondsAgo(45) },
      { last_seen_at: null }
    ];
    expect(countFreshHeartbeats(rows, NOW)).toBe(2);
  });
});

describe("isValidCourtNumber", () => {
  it("mirrors the controller's parseCourt range (integers 1-99)", () => {
    expect(isValidCourtNumber(1)).toBe(true);
    expect(isValidCourtNumber(8)).toBe(true);
    expect(isValidCourtNumber(99)).toBe(true);
    expect(isValidCourtNumber(0)).toBe(false);
    expect(isValidCourtNumber(100)).toBe(false);
    expect(isValidCourtNumber(1.5)).toBe(false);
    expect(isValidCourtNumber(-3)).toBe(false);
    expect(isValidCourtNumber(Number.NaN)).toBe(false);
    expect(isValidCourtNumber("3")).toBe(false);
    expect(isValidCourtNumber(null)).toBe(false);
  });
});

describe("normalizeControllerUrl", () => {
  it("rejects unset, blank, and non-http(s) values", () => {
    expect(normalizeControllerUrl(undefined)).toBeNull();
    expect(normalizeControllerUrl(null)).toBeNull();
    expect(normalizeControllerUrl("")).toBeNull();
    expect(normalizeControllerUrl("   ")).toBeNull();
    expect(normalizeControllerUrl("not a url")).toBeNull();
    expect(normalizeControllerUrl("ftp://controller.local")).toBeNull();
  });

  it("trims whitespace and trailing slashes from valid URLs", () => {
    expect(normalizeControllerUrl("http://10.0.0.5:8080")).toBe("http://10.0.0.5:8080");
    expect(normalizeControllerUrl("  https://controller.example.com/  ")).toBe("https://controller.example.com");
    expect(normalizeControllerUrl("https://controller.example.com///")).toBe("https://controller.example.com");
  });
});

describe("controller URL builders", () => {
  it("builds the controller's /courts/:n/start|stop shape", () => {
    expect(controllerCourtActionUrl("http://10.0.0.5:8080", 3, "start")).toBe("http://10.0.0.5:8080/courts/3/start");
    expect(controllerCourtActionUrl("http://10.0.0.5:8080/", 8, "stop")).toBe("http://10.0.0.5:8080/courts/8/stop");
  });

  it("returns null when the base URL or court number is invalid", () => {
    expect(controllerCourtActionUrl(null, 3, "start")).toBeNull();
    expect(controllerCourtActionUrl("", 3, "start")).toBeNull();
    expect(controllerCourtActionUrl("garbage", 3, "start")).toBeNull();
    expect(controllerCourtActionUrl("http://10.0.0.5:8080", 0, "start")).toBeNull();
    expect(controllerCourtActionUrl("http://10.0.0.5:8080", 100, "stop")).toBeNull();
    expect(controllerCourtActionUrl("http://10.0.0.5:8080", 2.5, "stop")).toBeNull();
  });

  it("builds the fleet-status /courts URL", () => {
    expect(controllerCourtsUrl("http://10.0.0.5:8080/")).toBe("http://10.0.0.5:8080/courts");
    expect(controllerCourtsUrl(undefined)).toBeNull();
  });
});

describe("parseControllerCourts", () => {
  it("never throws on garbage payloads", () => {
    expect(parseControllerCourts(null)).toEqual([]);
    expect(parseControllerCourts(undefined)).toEqual([]);
    expect(parseControllerCourts("nope")).toEqual([]);
    expect(parseControllerCourts({})).toEqual([]);
    expect(parseControllerCourts({ courts: "nope" })).toEqual([]);
    expect(parseControllerCourts({ courts: [null, 42, {}, { egressId: "" }] })).toEqual([]);
  });

  it("maps controller egress summaries defensively", () => {
    const egresses = parseControllerCourts({
      courts: [
        { egressId: "EG_1", court: 3, status: "EGRESS_ACTIVE", startedAt: "2026-07-08T11:59:00Z", error: null },
        { egressId: "EG_2", court: 120, status: 7, startedAt: 5, error: "" }
      ]
    });
    expect(egresses).toEqual([
      { egressId: "EG_1", court: 3, status: "EGRESS_ACTIVE", startedAt: "2026-07-08T11:59:00Z", error: null },
      { egressId: "EG_2", court: null, status: "UNKNOWN", startedAt: null, error: null }
    ]);
  });

  it("finds a court's egress by number", () => {
    const egresses = parseControllerCourts({
      courts: [{ egressId: "EG_1", court: 3, status: "EGRESS_ACTIVE", startedAt: null, error: null }]
    });
    expect(egressForCourt(egresses, 3)?.egressId).toBe("EG_1");
    expect(egressForCourt(egresses, 4)).toBeNull();
    expect(egressForCourt(null, 3)).toBeNull();
  });
});

describe("broadcastChipForEgress", () => {
  it("maps egress lifecycle statuses to chips", () => {
    expect(broadcastChipForEgress(null)).toEqual({ label: "Off air", tone: "idle" });
    const base = { egressId: "EG_1", court: 1, startedAt: null, error: null };
    expect(broadcastChipForEgress({ ...base, status: "EGRESS_ACTIVE" })).toEqual({ label: "On air", tone: "live" });
    expect(broadcastChipForEgress({ ...base, status: "EGRESS_STARTING" })).toEqual({ label: "Starting", tone: "pending" });
    expect(broadcastChipForEgress({ ...base, status: "EGRESS_ENDING" })).toEqual({ label: "Stopping", tone: "pending" });
    expect(broadcastChipForEgress({ ...base, status: "EGRESS_FAILED", error: "boom" })).toEqual({
      label: "Egress error",
      tone: "stale"
    });
    expect(broadcastChipForEgress({ ...base, status: "EGRESS_LIMIT_REACHED" })).toEqual({
      label: "EGRESS_LIMIT_REACHED",
      tone: "stale"
    });
  });
});

describe("maskStreamKey", () => {
  it("returns null for missing or blank keys", () => {
    expect(maskStreamKey(null)).toBeNull();
    expect(maskStreamKey(undefined)).toBeNull();
    expect(maskStreamKey("")).toBeNull();
    expect(maskStreamKey("   ")).toBeNull();
  });

  it("reveals nothing for short keys", () => {
    expect(maskStreamKey("abc")).toBe("••••");
    expect(maskStreamKey("1234567")).toBe("••••");
  });

  it("shows only the last 4 characters of real keys", () => {
    const key = "abcd-efgh-ijkl-mnop";
    const masked = maskStreamKey(key);
    expect(masked).toBe("••••mnop");
    expect(masked).not.toContain(key);
    expect(masked).not.toContain("abcd");
    expect(maskStreamKey("  12345678  ")).toBe("••••5678");
  });
});

describe("youtubeWatchUrl", () => {
  it("returns null for missing or blank video ids", () => {
    expect(youtubeWatchUrl(null)).toBeNull();
    expect(youtubeWatchUrl(undefined)).toBeNull();
    expect(youtubeWatchUrl("")).toBeNull();
    expect(youtubeWatchUrl("   ")).toBeNull();
  });

  it("builds the public watch URL from a video id", () => {
    expect(youtubeWatchUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(youtubeWatchUrl("  abc123XYZ_-  ")).toBe("https://www.youtube.com/watch?v=abc123XYZ_-");
  });

  it("URL-encodes ids so odd input cannot break the link", () => {
    expect(youtubeWatchUrl("a b&c")).toBe("https://www.youtube.com/watch?v=a%20b%26c");
  });
});

describe("buildProgramMonitorPath", () => {
  it("returns null when PROGRAM_PAGE_TOKEN is unset/blank or the court is invalid", () => {
    expect(buildProgramMonitorPath(3, null, "a".repeat(40), "dpl_test")).toBeNull();
    expect(buildProgramMonitorPath(3, undefined, "a".repeat(40), "dpl_test")).toBeNull();
    expect(buildProgramMonitorPath(3, "", "a".repeat(40), "dpl_test")).toBeNull();
    expect(buildProgramMonitorPath(3, "   ", "a".repeat(40), "dpl_test")).toBeNull();
    expect(buildProgramMonitorPath(0, "secret", "a".repeat(40), "dpl_test")).toBeNull();
    expect(buildProgramMonitorPath(100, "secret", "a".repeat(40), "dpl_test")).toBeNull();
    expect(buildProgramMonitorPath(1, "secret", "wrong", "dpl_test")).toBeNull();
    expect(buildProgramMonitorPath(1, "secret", "a".repeat(40), "wrong")).toBeNull();
  });

  it("builds the debug program link with an encoded token", () => {
    expect(buildProgramMonitorPath(3, "egress-secret", "a".repeat(40), "dpl_test")).toBe(
      `/program/bootstrap?court=3&build=${"a".repeat(40)}&deployment=dpl_test&debug=1#token=egress-secret`
    );
    expect(buildProgramMonitorPath(7, "s3cr3t/+= ", "b".repeat(40), "dpl_other")).toBe(
      `/program/bootstrap?court=7&build=${"b".repeat(40)}&deployment=dpl_other&debug=1#token=s3cr3t%2F%2B%3D`
    );
  });
});

describe("controller env wrappers", () => {
  it("requires both CONTROLLER_URL and CONTROLLER_TOKEN to be configured", () => {
    expect(controllerConfiguredFromEnv()).toBe(false);

    process.env.CONTROLLER_URL = "http://10.0.0.5:8080/";
    expect(controllerBaseUrlFromEnv()).toBe("http://10.0.0.5:8080");
    expect(controllerConfiguredFromEnv()).toBe(false);

    process.env.CONTROLLER_TOKEN = "  bearer-secret  ";
    expect(controllerConfiguredFromEnv()).toBe(true);

    process.env.CONTROLLER_URL = "not a url";
    expect(controllerBaseUrlFromEnv()).toBeNull();
    expect(controllerConfiguredFromEnv()).toBe(false);
  });
});
