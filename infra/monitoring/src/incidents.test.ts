import { describe, expect, it } from "vitest";
import { IncidentManager } from "./incidents.js";

describe("incident manager", () => {
  it("deduplicates continuing alerts and strips query strings", () => {
    const manager = new IncidentManager();
    const payload = {
      status: "firing",
      alerts: [{
        status: "firing",
        labels: { alertname: "ProgramFramesStalled", severity: "critical", stage: "PROGRAM_BROWSER", court: "3", root_dependency: "compositor-a", remoteAddr: "secret" },
        annotations: { summary: "Frames stopped; inspect https://example.test/path?token=secret", first_action: "Open compositor A." },
        startsAt: "2026-07-12T12:00:00Z"
      }]
    };
    const first = manager.applyWebhook(payload, new Date("2026-07-12T12:00:10Z"));
    const second = manager.applyWebhook(payload, new Date("2026-07-12T12:00:20Z"));
    expect(first[0]?.incident.id).toBe(second[0]?.incident.id);
    expect(first[0]?.incident.summary).toContain("https://example.test/path");
    expect(first[0]?.incident.summary).not.toContain("token=secret");
    expect(JSON.stringify(first[0]?.incident)).not.toContain("remoteAddr");
  });

  it("resolves the existing incident", () => {
    const manager = new IncidentManager();
    const firing = {
      status: "firing",
      alerts: [{ status: "firing", labels: { alertname: "AgentMissing", stage: "MONITORING" }, annotations: {} }]
    };
    manager.applyWebhook(firing, new Date("2026-07-12T12:00:00Z"));
    manager.applyWebhook({ ...firing, status: "resolved", alerts: [{ ...firing.alerts[0], status: "resolved" }] }, new Date("2026-07-12T12:01:00Z"));
    expect(manager.active()).toHaveLength(1);
    manager.reconcileActiveAlerts([], new Date("2026-07-12T12:02:00Z"));
    expect(manager.active()).toHaveLength(0);
    expect(manager.all()[0]?.status).toBe("resolved");
  });

  it("does not emit or persist duplicate resolved transitions", () => {
    const manager = new IncidentManager();
    const firing = {
      status: "firing" as const,
      alerts: [{ status: "firing" as const, labels: { alertname: "AgentMissing", stage: "MONITORING" }, annotations: {} }]
    };
    manager.applyWebhook(firing, new Date("2026-07-12T12:00:00Z"));
    const resolved = { ...firing, status: "resolved" as const, alerts: [{ ...firing.alerts[0], status: "resolved" as const }] };
    expect(manager.applyWebhook(resolved, new Date("2026-07-12T12:01:00Z"))).toEqual([]);
    expect(manager.applyWebhook(resolved, new Date("2026-07-12T12:01:30Z"))).toEqual([]);
    expect(manager.reconcileActiveAlerts([], new Date("2026-07-12T12:02:00Z")).map((change) => change.eventType)).toEqual(["RESOLVED"]);
    expect(manager.reconcileActiveAlerts([], new Date("2026-07-12T12:02:30Z"))).toEqual([]);
  });

  it("creates a new incident episode when the same fingerprint recurs in one process", () => {
    const manager = new IncidentManager();
    const firstFiring = firingAlert("2026-07-12T12:00:00Z");
    const [first] = manager.applyWebhook(firstFiring, new Date("2026-07-12T12:00:05Z"));
    manager.acknowledge(first!.incident.id, "operator", "Investigating", new Date("2026-07-12T12:00:20Z"));
    manager.applyWebhook(resolvedAlert(firstFiring, "2026-07-12T12:01:00Z"), new Date("2026-07-12T12:01:00Z"));
    manager.reconcileActiveAlerts([], new Date("2026-07-12T12:02:00Z"));

    const [second] = manager.applyWebhook(firingAlert("2026-07-12T12:02:00Z"), new Date("2026-07-12T12:02:05Z"));

    expect(second?.eventType).toBe("OPENED");
    expect(second?.incident.id).not.toBe(first?.incident.id);
    expect(second?.incident.openedAt).toBe("2026-07-12T12:02:00.000Z");
    expect(second?.incident.acknowledgedAt).toBeNull();
    expect(second?.incident.acknowledgedBy).toBeNull();
  });

  it("creates a new incident episode after restart because resolved rows are not hydrated", () => {
    const firstProcess = new IncidentManager();
    const firstFiring = firingAlert("2026-07-12T12:00:00Z");
    const [first] = firstProcess.applyWebhook(firstFiring, new Date("2026-07-12T12:00:05Z"));
    firstProcess.applyWebhook(resolvedAlert(firstFiring, "2026-07-12T12:01:00Z"), new Date("2026-07-12T12:01:00Z"));
    firstProcess.reconcileActiveAlerts([], new Date("2026-07-12T12:02:00Z"));

    const restartedProcess = new IncidentManager();
    restartedProcess.hydrate([]);
    const [second] = restartedProcess.applyWebhook(firingAlert("2026-07-12T12:02:00Z"), new Date("2026-07-12T12:02:05Z"));

    expect(second?.eventType).toBe("OPENED");
    expect(second?.incident.id).not.toBe(first?.incident.id);
    expect(second?.incident.fingerprint).toBe(first?.incident.fingerprint);
    expect(second?.incident.openedAt).toBe("2026-07-12T12:02:00.000Z");
  });

  it("retains the durable active episode id after restart", () => {
    const firstProcess = new IncidentManager();
    const firing = firingAlert("2026-07-12T12:00:00Z");
    const [first] = firstProcess.applyWebhook(firing, new Date("2026-07-12T12:00:05Z"));

    const restartedProcess = new IncidentManager();
    restartedProcess.hydrate([first!.incident]);
    const [continued] = restartedProcess.applyWebhook(firing, new Date("2026-07-12T12:00:30Z"));

    expect(continued?.eventType).toBe("EVIDENCE_UPDATED");
    expect(continued?.incident.id).toBe(first?.incident.id);
    expect(continued?.incident.openedAt).toBe(first?.incident.openedAt);
  });

  it("retains an enriched event id when continuing alerts omit it", () => {
    const manager = new IncidentManager();
    const firing = firingAlert("2026-07-12T12:00:00Z");
    const [opened] = manager.applyWebhook(firing, new Date("2026-07-12T12:00:05Z"));
    const eventId = "00000000-0000-4000-8000-000000000111";
    manager.hydrate([{ ...opened!.incident, eventId }]);

    const [continued] = manager.applyWebhook(firing, new Date("2026-07-12T12:00:30Z"));

    expect(continued?.incident.eventId).toBe(eventId);
  });

  it("reconciles a missed resolved webhook from the authoritative active set", () => {
    const manager = new IncidentManager();
    manager.applyWebhook({
      status: "firing",
      alerts: [{ status: "firing", labels: { alertname: "AgentMissing", stage: "MONITORING" }, annotations: {} }]
    }, new Date("2026-07-12T12:00:00Z"));
    expect(manager.reconcileActiveAlerts([], new Date("2026-07-12T12:01:00Z"))).toEqual([]);
    const changes = manager.reconcileActiveAlerts([], new Date("2026-07-12T12:02:00Z"));
    expect(changes.map((change) => change.eventType)).toEqual(["RESOLVED"]);
    expect(manager.active()).toHaveLength(0);
  });

  it("does not emit database churn while an active alert is unchanged", () => {
    const manager = new IncidentManager();
    const alert = activeApiAlert({ alertname: "AgentMissing", stage: "MONITORING" });
    manager.reconcileActiveAlerts([alert], new Date("2026-07-12T12:00:00Z"));
    expect(manager.reconcileActiveAlerts([alert], new Date("2026-07-12T12:00:30Z"))).toEqual([]);
  });

  it("excludes Alertmanager-suppressed alerts from the authoritative active set", () => {
    const manager = new IncidentManager();
    const alert = activeApiAlert({ alertname: "ProgramBranchMissing", stage: "PROGRAM_PATH", court: "5" });
    manager.reconcileActiveAlerts([alert], new Date("2026-07-12T12:00:00Z"));

    const changes = manager.reconcileActiveAlerts([{
      ...alert,
      status: { state: "suppressed" as const }
    }], new Date("2026-07-12T12:00:30Z"));

    expect(changes).toEqual([]);
    const resolved = manager.reconcileActiveAlerts([{
      ...alert,
      status: { state: "suppressed" as const }
    }], new Date("2026-07-12T12:01:30Z"));

    expect(resolved.map((change) => change.eventType)).toEqual(["RESOLVED"]);
    expect(manager.active()).toHaveLength(0);
  });

  it("keeps an incident open across a bounded alert reload gap", () => {
    const manager = new IncidentManager();
    const alert = activeApiAlert({ alertname: "RawMediaStalled", stage: "RAW_INGEST", court: "4" });
    const [opened] = manager.reconcileActiveAlerts([alert], new Date("2026-07-12T12:00:00Z"));

    expect(manager.reconcileActiveAlerts([], new Date("2026-07-12T12:00:30Z"))).toEqual([]);
    expect(manager.reconcileActiveAlerts([alert], new Date("2026-07-12T12:01:00Z"))).toEqual([]);
    expect(manager.active()[0]?.id).toBe(opened?.incident.id);
    expect(manager.active()[0]?.status).toBe("open");
  });

  it("keeps the same episode when a resolved webhook refires during a rule reload", () => {
    const manager = new IncidentManager();
    const firing = firingAlert("2026-07-12T12:00:00Z");
    const [opened] = manager.applyWebhook(firing, new Date("2026-07-12T12:00:00Z"));

    expect(manager.applyWebhook(resolvedAlert(firing, "2026-07-12T12:00:30Z"), new Date("2026-07-12T12:00:30Z"))).toEqual([]);
    expect(manager.applyWebhook(firing, new Date("2026-07-12T12:00:50Z")).map((change) => change.eventType)).toEqual(["EVIDENCE_UPDATED"]);
    expect(manager.active()[0]?.id).toBe(opened?.incident.id);
    expect(manager.active()[0]?.status).toBe("open");
  });

  it("records a sanitized acknowledgement reason", () => {
    const manager = new IncidentManager();
    const [opened] = manager.applyWebhook({
      status: "firing",
      alerts: [{ status: "firing", labels: { alertname: "AgentMissing", stage: "MONITORING" }, annotations: {} }]
    }, new Date("2026-07-12T12:00:00Z"));
    const change = manager.acknowledge(opened!.incident.id, "operator", "Investigating https://example.test/path?secret=value", new Date("2026-07-12T12:01:00Z"));
    expect(change?.detail?.reason).toBe("Investigating https://example.test/path");
  });
});

function firingAlert(startsAt: string) {
  return {
    status: "firing" as const,
    alerts: [{
      status: "firing" as const,
      labels: {
        alertname: "ScoreCheckRequiredRawPathMissing",
        severity: "critical",
        stage: "RAW_INGEST",
        court: "1",
        root_dependency: "mediamtx"
      },
      annotations: { summary: "Camera 1 is offline." },
      startsAt
    }]
  };
}

function activeApiAlert(labels: Record<string, string>) {
  return {
    labels,
    annotations: {},
    status: { state: "active" as const }
  };
}

function resolvedAlert(firing: ReturnType<typeof firingAlert>, endsAt: string) {
  return {
    status: "resolved" as const,
    alerts: firing.alerts.map((alert) => ({ ...alert, status: "resolved" as const, endsAt }))
  };
}
