import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { coerceOverlayState } from "./overlayState";

const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHE_BYTES = 64 * 1024;

export type CachedProgramCourt = {
  programStreamPath: string | null;
  cameraGainDb: number;
  commentaryGainDb: number;
  commentaryDelayMs: number;
  programVideoDelayMs: number;
  configurationVersion: string;
};

type OverlayState = ReturnType<typeof coerceOverlayState>;

export async function readCachedProgramCourt(courtNumber: number): Promise<CachedProgramCourt | null> {
  const value = await readCache(cacheFile("court", courtNumber));
  if (!value || value.schemaVersion !== CACHE_SCHEMA_VERSION || value.kind !== "court") return null;
  return validCourt(value.payload) ? value.payload : null;
}

export async function writeCachedProgramCourt(courtNumber: number, payload: CachedProgramCourt): Promise<void> {
  if (!validCourt(payload)) throw new Error("program court cache payload is invalid");
  await writeCache(cacheFile("court", courtNumber), { schemaVersion: CACHE_SCHEMA_VERSION, kind: "court", payload });
}

export async function readCachedOverlayState(courtNumber: number, eventId: string | null): Promise<OverlayState | null> {
  const value = await readCache(cacheFile("overlay", courtNumber));
  if (!value || value.schemaVersion !== CACHE_SCHEMA_VERSION || value.kind !== "overlay") return null;
  const state = coerceOverlayState(value.payload, courtNumber);
  if (eventId && state.eventId !== eventId) return null;
  return state;
}

export async function writeCachedOverlayState(courtNumber: number, payload: OverlayState): Promise<void> {
  const state = coerceOverlayState(payload, courtNumber);
  await writeCache(cacheFile("overlay", courtNumber), { schemaVersion: CACHE_SCHEMA_VERSION, kind: "overlay", payload: state });
}

export function staleCachedOverlayState(payload: OverlayState): OverlayState {
  return {
    ...payload,
    health: {
      ...payload.health,
      apiOnline: false,
      stale: true,
      message: "Showing the last confirmed score while scoring is unavailable"
    }
  };
}

function cacheFile(kind: "court" | "overlay", courtNumber: number): string | null {
  if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > 8) return null;
  const root = process.env.SCORECHECK_PROGRAM_CACHE_DIR?.trim();
  if (!root || !isAbsolute(root) || resolve(root) !== root || root === "/" || root.includes("\0")) return null;
  return join(root, `${kind}-${courtNumber}.json`);
}

async function readCache(path: string | null): Promise<Record<string, unknown> | null> {
  if (!path) return null;
  try {
    const information = await lstat(path);
    if (!information.isFile() || information.isSymbolicLink() || information.size > MAX_CACHE_BYTES) return null;
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function writeCache(path: string | null, value: Record<string, unknown>): Promise<void> {
  if (!path) return;
  const root = resolve(path, "..");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInformation = await lstat(root);
  if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) throw new Error("program cache directory is not a regular directory");
  await chmod(root, 0o700);
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body) > MAX_CACHE_BYTES) throw new Error("program cache payload is too large");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function validCourt(value: unknown): value is CachedProgramCourt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const court = value as Record<string, unknown>;
  return (court.programStreamPath === null || typeof court.programStreamPath === "string")
    && [court.cameraGainDb, court.commentaryGainDb, court.commentaryDelayMs, court.programVideoDelayMs].every(Number.isFinite)
    && typeof court.configurationVersion === "string"
    && court.configurationVersion.length > 0
    && court.configurationVersion.length <= 64;
}
