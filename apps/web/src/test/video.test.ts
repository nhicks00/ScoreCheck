import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { courtMonitorStreamPath, courtPreviewStreamPath, courtProgramStreamPath, courtRawStreamPath, courtStreamSources, dataSaverStreamAdmitted, videoConfigured } from "../lib/video";

const VIDEO_ENV_KEYS = [
  "MEDIAMTX_WHEP_BASE_URL",
  "MEDIAMTX_HLS_BASE_URL",
  "MEDIAMTX_READ_USER",
  "MEDIAMTX_READ_PASS",
  "COURT_3_PREVIEW_STREAM_PATH",
  "COURT_4_PROGRAM_STREAM_PATH"
];

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of VIDEO_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of VIDEO_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("videoConfigured", () => {
  it("is false when no MediaMTX base URL is set", () => {
    expect(videoConfigured()).toBe(false);
  });

  it("is true when only the WHEP base is set", () => {
    process.env.MEDIAMTX_WHEP_BASE_URL = "https://live.example.com";
    expect(videoConfigured()).toBe(true);
  });

  it("is true when only the HLS base is set", () => {
    process.env.MEDIAMTX_HLS_BASE_URL = "http://1.2.3.4:8888";
    expect(videoConfigured()).toBe(true);
  });
});

describe("courtPreviewStreamPath", () => {
  it("defaults to a distinct preview path", () => {
    expect(courtPreviewStreamPath(4)).toBe("court4_preview");
  });

  it("prefers the COURT_{N}_PREVIEW_STREAM_PATH env over the default", () => {
    process.env.COURT_3_PREVIEW_STREAM_PATH = "center-court";
    expect(courtPreviewStreamPath(3)).toBe("center-court");
  });

  it("prefers the database path over env and default", () => {
    process.env.COURT_3_PREVIEW_STREAM_PATH = "center-court";
    expect(courtPreviewStreamPath(3, "custom-path")).toBe("custom-path");
  });

  it("ignores blank database values and trims slashes", () => {
    expect(courtPreviewStreamPath(2, "   ")).toBe("court2_preview");
    expect(courtPreviewStreamPath(2, "/court-two/ ")).toBe("court-two");
  });
});

describe("courtRawStreamPath", () => {
  it("keeps a permanent encoder identity separate from preview and program", () => {
    expect(courtRawStreamPath(4)).toBe("court4_raw");
  });
});

describe("courtMonitorStreamPath", () => {
  it("uses the permanent camera number for the low-bandwidth monitor rendition", () => {
    expect(courtMonitorStreamPath(4)).toBe("court4_monitor");
  });
});

describe("dataSaverStreamAdmitted", () => {
  it("admits the extra monitor transcode only for an explicit off expectation", () => {
    expect(dataSaverStreamAdmitted("OFF")).toBe(true);
    expect(dataSaverStreamAdmitted("LIVE")).toBe(false);
    expect(dataSaverStreamAdmitted("TESTING")).toBe(false);
    expect(dataSaverStreamAdmitted(null)).toBe(false);
    expect(dataSaverStreamAdmitted(undefined)).toBe(false);
  });
});

describe("courtProgramStreamPath", () => {
  it("defaults to a distinct program path", () => {
    expect(courtProgramStreamPath(4)).toBe("court4_program");
  });

  it("prefers database, then environment, then default", () => {
    process.env.COURT_4_PROGRAM_STREAM_PATH = "court-four-delayed";
    expect(courtProgramStreamPath(4)).toBe("court-four-delayed");
    expect(courtProgramStreamPath(4, "/custom-program/")).toBe("custom-program");
  });
});

describe("courtStreamSources", () => {
  it("returns nulls when MediaMTX is not configured", () => {
    expect(courtStreamSources("court1")).toEqual({ whepUrl: null, hlsUrl: null });
  });

  it("builds WHEP and HLS URLs from the base URLs", () => {
    process.env.MEDIAMTX_WHEP_BASE_URL = "https://live.example.com";
    process.env.MEDIAMTX_HLS_BASE_URL = "http://1.2.3.4:8888";
    expect(courtStreamSources("court1")).toEqual({
      whepUrl: "https://live.example.com/court1/whep",
      hlsUrl: "http://1.2.3.4:8888/court1/index.m3u8"
    });
  });

  it("handles trailing slashes on base URLs", () => {
    process.env.MEDIAMTX_WHEP_BASE_URL = "https://live.example.com/";
    process.env.MEDIAMTX_HLS_BASE_URL = "http://1.2.3.4:8888///";
    expect(courtStreamSources("court5")).toEqual({
      whepUrl: "https://live.example.com/court5/whep",
      hlsUrl: "http://1.2.3.4:8888/court5/index.m3u8"
    });
  });

  it("returns only the configured protocol", () => {
    process.env.MEDIAMTX_WHEP_BASE_URL = "https://live.example.com";
    expect(courtStreamSources("court1")).toEqual({
      whepUrl: "https://live.example.com/court1/whep",
      hlsUrl: null
    });
  });

  it("appends read credentials as query params when configured", () => {
    process.env.MEDIAMTX_WHEP_BASE_URL = "https://live.example.com";
    process.env.MEDIAMTX_HLS_BASE_URL = "https://live.example.com/hls";
    process.env.MEDIAMTX_READ_USER = "viewer";
    process.env.MEDIAMTX_READ_PASS = "s3cret&pass";
    expect(courtStreamSources("court1")).toEqual({
      whepUrl: "https://live.example.com/court1/whep?user=viewer&pass=s3cret%26pass",
      hlsUrl: "https://live.example.com/hls/court1/index.m3u8?user=viewer&pass=s3cret%26pass"
    });
  });

  it("omits credentials when only one half is configured", () => {
    process.env.MEDIAMTX_WHEP_BASE_URL = "https://live.example.com";
    process.env.MEDIAMTX_READ_USER = "viewer";
    expect(courtStreamSources("court1")).toEqual({
      whepUrl: "https://live.example.com/court1/whep",
      hlsUrl: null
    });
  });

  it("returns nulls for a blank stream path", () => {
    process.env.MEDIAMTX_WHEP_BASE_URL = "https://live.example.com";
    expect(courtStreamSources("  ")).toEqual({ whepUrl: null, hlsUrl: null });
  });
});
