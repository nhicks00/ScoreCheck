import { describe, expect, it } from "vitest";
import { ifNoneMatchContains, overlayEntityTag } from "../lib/overlayHttp";
import { coerceOverlayState } from "../lib/overlayState";

describe("overlay conditional repair", () => {
  it("produces a stable scope-and-revision entity tag", () => {
    const state = coerceOverlayState({
      eventId: "event-1",
      courtId: "court-1",
      match: { id: "match-1" },
      projection: { scoreRevision: 7, bodyChecksum: "a".repeat(64) }
    });
    expect(overlayEntityTag(state)).toMatch(/^W\/"overlay-[a-f0-9]{64}"$/);
    expect(overlayEntityTag(state)).toBe(overlayEntityTag(structuredClone(state)));
    const advanced = coerceOverlayState({ ...state, projection: { ...state.projection, scoreRevision: 8 } });
    expect(overlayEntityTag(advanced)).not.toBe(overlayEntityTag(state));
  });

  it("changes the entity tag when cached health becomes authoritative", () => {
    const current = coerceOverlayState({
      eventId: "event-1",
      courtId: "court-1",
      match: { id: "match-1" },
      projection: { scoreRevision: 7, bodyChecksum: "a".repeat(64) },
      health: { apiOnline: true, stale: false, message: null }
    });
    const cached = coerceOverlayState({
      ...current,
      health: { ...current.health, apiOnline: false, stale: true, message: "Showing the last confirmed score while scoring is unavailable" }
    });

    expect(overlayEntityTag(cached)).not.toBe(overlayEntityTag(current));
  });

  it("matches strong, weak, wildcard, and comma-separated validators", () => {
    const etag = '"overlay-test"';
    expect(ifNoneMatchContains(etag, etag)).toBe(true);
    expect(ifNoneMatchContains(`"other", W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchContains(etag, `W/${etag}`)).toBe(true);
    expect(ifNoneMatchContains("*", etag)).toBe(true);
    expect(ifNoneMatchContains('"other"', etag)).toBe(false);
    expect(ifNoneMatchContains(null, etag)).toBe(false);
  });
});
