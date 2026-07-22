import { createHash } from "node:crypto";
import type { OverlayState } from "./types";

export function overlayEntityTag(state: OverlayState): string {
  const scope = [
    state.projection.schemaVersion,
    state.eventId,
    state.courtId,
    state.match.id ?? "no-match",
    state.projection.scoreRevision,
    state.projection.bodyChecksum ?? createHash("sha256").update(JSON.stringify(state)).digest("hex")
  ].join(":");
  return `W/"overlay-${createHash("sha256").update(scope).digest("hex")}"`;
}

export function ifNoneMatchContains(value: string | null, etag: string): boolean {
  if (!value) return false;
  const expected = withoutWeakPrefix(etag);
  return value.split(",").map((entry) => entry.trim()).some((entry) => entry === "*" || withoutWeakPrefix(entry) === expected);
}

function withoutWeakPrefix(value: string): string {
  return value.startsWith("W/") ? value.slice(2) : value;
}
