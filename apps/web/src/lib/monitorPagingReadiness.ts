import type { MonitorHealthState, MonitorSnapshot } from "./monitoringTypes";

type NotificationHealth = MonitorSnapshot["notifications"];
type ProviderHealth = NotificationHealth["pushover"];
type ProviderReadiness = "OFF" | "UNTESTED" | "READY" | "FAILED";

export type MonitorPagingReadiness = {
  label: string;
  state: MonitorHealthState;
};

export function deriveMonitorPagingReadiness(notifications: NotificationHealth): MonitorPagingReadiness {
  const push = providerReadiness(notifications.pushover);
  const sms = providerReadiness(notifications.twilioSms);

  if (push === "OFF" && sms === "OFF") {
    return { label: "Phone alerts off", state: "DEGRADED" };
  }

  const label = push === "READY" && sms === "READY"
    ? "Push + SMS ready"
    : `${providerLabel("Push", push)} · ${providerLabel("SMS", sms)}`;

  if (notifications.state === "DEGRADED" && push === "READY" && sms === "READY") {
    return { label: "Phone delivery failed", state: "DEGRADED" };
  }
  if (notifications.state === "DEGRADED" || push === "FAILED" || sms === "FAILED" || push === "OFF" || sms === "OFF") {
    return { label, state: "DEGRADED" };
  }
  if (notifications.state === "UNKNOWN" || push === "UNTESTED" || sms === "UNTESTED") {
    return { label, state: "UNKNOWN" };
  }
  return { label, state: "HEALTHY" };
}

function providerReadiness(provider: ProviderHealth): ProviderReadiness {
  if (!provider.configured) return "OFF";
  if (provider.lastFailureAt) return "FAILED";
  if (provider.lastSuccessAt) return "READY";
  return "UNTESTED";
}

function providerLabel(name: "Push" | "SMS", readiness: ProviderReadiness): string {
  if (readiness === "OFF") return `${name} off`;
  if (readiness === "UNTESTED") return `${name} untested`;
  if (readiness === "FAILED") return `${name} failed`;
  return `${name} ready`;
}
