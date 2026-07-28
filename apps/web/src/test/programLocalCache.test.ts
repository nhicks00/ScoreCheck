import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { fallbackOverlayState } from "../lib/overlayState";
import {
  readCachedOverlayState,
  readCachedProgramCourt,
  staleCachedOverlayState,
  writeCachedOverlayState,
  writeCachedProgramCourt
} from "../lib/programLocalCache";

let root: string | null = null;

afterEach(async () => {
  delete process.env.SCORECHECK_PROGRAM_CACHE_DIR;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("program local cache", () => {
  test("persists a validated court configuration atomically", async () => {
    root = await mkdtemp(join(tmpdir(), "scorecheck-program-cache-"));
    process.env.SCORECHECK_PROGRAM_CACHE_DIR = root;
    const court = {
      programStreamPath: "court3_program",
      cameraGainDb: -2,
      commentaryGainDb: 1,
      commentaryDelayMs: 320,
      programVideoDelayMs: 3500,
      configurationVersion: "court-id:123"
    };
    await writeCachedProgramCourt(3, court);
    expect(await readCachedProgramCourt(3)).toEqual(court);
    expect(JSON.parse(await readFile(join(root, "court-3.json"), "utf8"))).toMatchObject({ schemaVersion: 1, kind: "court" });
  });

  test("rejects corrupt cache data without breaking renderer startup", async () => {
    root = await mkdtemp(join(tmpdir(), "scorecheck-program-cache-"));
    process.env.SCORECHECK_PROGRAM_CACHE_DIR = root;
    await writeFile(join(root, "court-1.json"), "{broken", { mode: 0o600 });
    expect(await readCachedProgramCourt(1)).toBeNull();
  });

  test("keeps a last-good overlay event-scoped and marks fallback stale", async () => {
    root = await mkdtemp(join(tmpdir(), "scorecheck-program-cache-"));
    process.env.SCORECHECK_PROGRAM_CACHE_DIR = root;
    const current = fallbackOverlayState(5);
    current.eventId = "event-5";
    current.health.apiOnline = true;
    await writeCachedOverlayState(5, current);
    expect(await readCachedOverlayState(5, "other-event")).toBeNull();
    const cached = await readCachedOverlayState(5, "event-5");
    expect(staleCachedOverlayState(cached!).health).toMatchObject({ apiOnline: false, stale: true });
  });

  test("is inert when no compositor cache directory is configured", async () => {
    await writeCachedProgramCourt(1, {
      programStreamPath: null,
      cameraGainDb: 0,
      commentaryGainDb: 0,
      commentaryDelayMs: 0,
      programVideoDelayMs: 3500,
      configurationVersion: "none"
    });
    expect(await readCachedProgramCourt(1)).toBeNull();
  });
});
