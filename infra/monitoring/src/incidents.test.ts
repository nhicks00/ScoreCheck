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
    expect(manager.applyWebhook(resolved, new Date("2026-07-12T12:01:00Z"))).toHaveLength(1);
    expect(manager.applyWebhook(resolved, new Date("2026-07-12T12:01:30Z"))).toEqual([]);
    expect(manager.reconcileActiveAlerts([], new Date("2026-07-12T12:02:00Z"))).toEqual([]);
  });

  it("reconciles a missed resolved webhook from the authoritative active set", () => {
    const manager = new IncidentManager();
    manager.applyWebhook({
      status: "firing",
      alerts: [{ status: "firing", labels: { alertname: "AgentMissing", stage: "MONITORING" }, annotations: {} }]
    }, new Date("2026-07-12T12:00:00Z"));
    const changes = manager.reconcileActiveAlerts([], new Date("2026-07-12T12:01:00Z"));
    expect(changes.map((change) => change.eventType)).toEqual(["RESOLVED"]);
    expect(manager.active()).toHaveLength(0);
  });

  it("does not emit database churn while an active alert is unchanged", () => {
    const manager = new IncidentManager();
    const alert = { labels: { alertname: "AgentMissing", stage: "MONITORING" }, annotations: {} };
    manager.reconcileActiveAlerts([alert], new Date("2026-07-12T12:00:00Z"));
    expect(manager.reconcileActiveAlerts([alert], new Date("2026-07-12T12:00:30Z"))).toEqual([]);
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
