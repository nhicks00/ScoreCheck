import { describe, expect, it } from "vitest";
import type { IncidentSnapshot, MonitoringSilence } from "./contracts.js";
import { activeSilences, incidentIsSilenced, silenceMatchesIncident } from "./silences.js";

const now = new Date("2026-07-12T18:00:00.000Z");
const incident: IncidentSnapshot = {
  id: "00000000-0000-4000-8000-000000000001",
  fingerprint: "fingerprint",
  eventId: "00000000-0000-4000-8000-000000000002",
  rootDependency: "mediamtx",
  status: "open",
  severity: "critical",
  stage: "RAW_INGEST",
  issueCode: "REQUIRED_RAW_PATH_MISSING",
  courtNumber: 1,
  host: "bvm-preview-01",
  summary: "Raw ingest is missing.",
  firstAction: "Check the camera publish path.",
  openedAt: now.toISOString(),
  lastObservedAt: now.toISOString(),
  acknowledgedAt: null,
  acknowledgedBy: null,
  resolvedAt: null
};

function silence(patch: Partial<MonitoringSilence> = {}): MonitoringSilence {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    eventId: incident.eventId,
    courtNumber: 1,
    stage: "RAW_INGEST",
    issueCode: "REQUIRED_RAW_PATH_MISSING",
    reason: "Planned camera swap.",
    createdBy: "scorecheck-admin",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    ...patch
  };
}

describe("monitoring silences", () => {
  it("matches only the scoped active incident", () => {
    expect(silenceMatchesIncident(silence(), incident, now)).toBe(true);
    expect(silenceMatchesIncident(silence({ courtNumber: 2 }), incident, now)).toBe(false);
    expect(silenceMatchesIncident(silence({ issueCode: "OTHER" }), incident, now)).toBe(false);
    expect(silenceMatchesIncident(silence({ expiresAt: now.toISOString() }), incident, now)).toBe(false);
  });

  it("allows intentionally broader stage or court scopes", () => {
    expect(incidentIsSilenced(incident, [silence({ issueCode: null })], now)).toBe(true);
    expect(incidentIsSilenced(incident, [silence({ courtNumber: null, stage: null })], now)).toBe(true);
  });

  it("removes expired silences and orders the remaining expiration times", () => {
    const later = silence({ id: "00000000-0000-4000-8000-000000000004", expiresAt: new Date(now.getTime() + 60_000).toISOString() });
    const sooner = silence({ id: "00000000-0000-4000-8000-000000000005", expiresAt: new Date(now.getTime() + 30_000).toISOString() });
    const expired = silence({ id: "00000000-0000-4000-8000-000000000006", expiresAt: new Date(now.getTime() - 1).toISOString() });
    expect(activeSilences([later, expired, sooner], now).map((entry) => entry.id)).toEqual([sooner.id, later.id]);
  });
});
