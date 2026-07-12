import type { IncidentSnapshot, MonitoringSilence } from "./contracts.js";

export function activeSilences(silences: MonitoringSilence[], now = new Date()): MonitoringSilence[] {
  const nowMs = now.getTime();
  return silences
    .filter((silence) => Date.parse(silence.expiresAt) > nowMs)
    .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));
}

export function silenceMatchesIncident(silence: MonitoringSilence, incident: IncidentSnapshot, now = new Date()): boolean {
  if (Date.parse(silence.expiresAt) <= now.getTime()) return false;
  return (silence.eventId == null || silence.eventId === incident.eventId)
    && (silence.courtNumber == null || silence.courtNumber === incident.courtNumber)
    && (silence.stage == null || silence.stage === incident.stage)
    && (silence.issueCode == null || silence.issueCode === incident.issueCode);
}

export function incidentIsSilenced(incident: IncidentSnapshot, silences: MonitoringSilence[], now = new Date()): boolean {
  return silences.some((silence) => silenceMatchesIncident(silence, incident, now));
}
