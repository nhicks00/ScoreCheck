import type { MonitorAgent } from "./monitoringTypes";

type MonitorEgress = NonNullable<NonNullable<MonitorAgent["nativeServices"]>["egress"]>;

export function egressRuntimeHealthy(egress: MonitorEgress): boolean {
  if (egress.maximumWebRequests < 1 || egress.activeWebRequests < 0 || egress.activeWebRequests > egress.maximumWebRequests) return false;
  if (egress.idle) return egress.activeWebRequests === 0 && egress.canAcceptRequest && egress.nativeCanAcceptRequest;
  return egress.activeWebRequests === egress.maximumWebRequests && !egress.canAcceptRequest && !egress.nativeCanAcceptRequest;
}
