import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { communityMediaReadiness } from "../scripts/setup/communityMediaReadiness";

const validEnv = {
  mediamtxWhepBaseUrl: "https://origin.example.com/webrtc",
  communityMediaWhepBaseUrl: "https://edge.example.com/webrtc",
  communityMediaReadUser: "reader",
  communityMediaReadPass: "secret",
  communityMediaMaxPerCourt: 25,
  communityMediaMaxTotal: 100,
  communityMediaSessionSeconds: 120
};

const validRawEnv = {
  COMMUNITY_MEDIA_MAX_PER_COURT: "25",
  COMMUNITY_MEDIA_MAX_TOTAL: "100",
  COMMUNITY_MEDIA_SESSION_SECONDS: "120"
};

describe("community media release readiness", () => {
  it("passes only with isolated endpoints, bounded capacity, credentials, and worker cleanup export", () => {
    expect(communityMediaReadiness({
      env: validEnv,
      rawEnv: validRawEnv,
      workerEnvKeys: new Set([
        "COMMUNITY_MEDIA_WHEP_BASE_URL",
        "COMMUNITY_MEDIA_READ_USER",
        "COMMUNITY_MEDIA_READ_PASS"
      ])
    })).toMatchObject({ status: "ok", issues: [] });
  });

  it("blocks a shared origin hostname, unsafe limits, and missing cleanup-worker credentials", () => {
    const result = communityMediaReadiness({
      env: {
        ...validEnv,
        communityMediaWhepBaseUrl: "https://origin.example.com:9443/edge",
        communityMediaReadUser: "",
        communityMediaMaxPerCourt: 0,
        communityMediaMaxTotal: 0
      },
      rawEnv: {
        COMMUNITY_MEDIA_MAX_PER_COURT: "1.5",
        COMMUNITY_MEDIA_MAX_TOTAL: "20001",
        COMMUNITY_MEDIA_SESSION_SECONDS: "601"
      },
      workerEnvKeys: new Set()
    });

    expect(result.status).toBe("blocked");
    expect(result.issues.join(" ")).toMatch(/must not share a hostname/i);
    expect(result.issues.join(" ")).toMatch(/read_user/i);
    expect(result.issues.join(" ")).toMatch(/integer from 1 through 5000/i);
    expect(result.issues.join(" ")).toMatch(/integer from 1 through 20000/i);
    expect(result.issues.join(" ")).toMatch(/integer from 30 through 600/i);
    expect(result.issues.join(" ")).toMatch(/worker environment is missing/i);
  });

  it("exports literal zero capacity and the worker cleanup connection settings", () => {
    const source = readFileSync(join(process.cwd(), "src/scripts/setup/vercelEnvExport.ts"), "utf8");
    expect(source).toContain('vercelLines.push(["COMMUNITY_MEDIA_MAX_PER_COURT", String(env.communityMediaMaxPerCourt)])');
    expect(source).toContain('vercelLines.push(["COMMUNITY_MEDIA_MAX_TOTAL", String(env.communityMediaMaxTotal)])');
    expect(source).toContain('pushIfPresent(workerLines, "COMMUNITY_MEDIA_WHEP_BASE_URL", env.communityMediaWhepBaseUrl)');
    expect(source).toContain('pushIfPresent(workerLines, "COMMUNITY_MEDIA_READ_USER", env.communityMediaReadUser)');
    expect(source).toContain('pushIfPresent(workerLines, "COMMUNITY_MEDIA_READ_PASS", env.communityMediaReadPass)');
  });
});
