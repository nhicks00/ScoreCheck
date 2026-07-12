import { Counter, Gauge, Registry } from "prom-client";
import type { AgentSnapshot } from "./contracts.js";

export class AgentMetrics {
  readonly registry = new Registry();
  private readonly up = new Gauge({ name: "scorecheck_agent_up", help: "Whether the agent completed its latest collection.", labelNames: ["agent", "role"], registers: [this.registry] });
  private readonly collectionDuration = new Gauge({ name: "scorecheck_agent_collection_duration_seconds", help: "Latest collection duration.", labelNames: ["agent", "role"], registers: [this.registry] });
  private readonly collectionErrors = new Counter({ name: "scorecheck_agent_collection_errors_total", help: "Collection errors by bounded issue code.", labelNames: ["agent", "role", "issue_code"], registers: [this.registry] });
  private readonly hostUptime = new Gauge({ name: "scorecheck_host_uptime_seconds", help: "Host uptime.", labelNames: ["agent", "role"], registers: [this.registry] });
  private readonly hostLoad1 = new Gauge({ name: "scorecheck_host_load1", help: "One-minute host load average.", labelNames: ["agent", "role"], registers: [this.registry] });
  private readonly memoryTotal = new Gauge({ name: "scorecheck_host_memory_total_bytes", help: "Host total memory.", labelNames: ["agent", "role"], registers: [this.registry] });
  private readonly memoryAvailable = new Gauge({ name: "scorecheck_host_memory_available_bytes", help: "Host available memory.", labelNames: ["agent", "role"], registers: [this.registry] });
  private readonly diskTotal = new Gauge({ name: "scorecheck_host_disk_total_bytes", help: "Host filesystem total bytes.", labelNames: ["agent", "role"], registers: [this.registry] });
  private readonly diskFree = new Gauge({ name: "scorecheck_host_disk_free_bytes", help: "Host filesystem free bytes.", labelNames: ["agent", "role"], registers: [this.registry] });
  private readonly serviceRunning = new Gauge({ name: "scorecheck_service_running", help: "Whether an allowlisted service container is running.", labelNames: ["agent", "role", "service"], registers: [this.registry] });
  private readonly serviceHealthy = new Gauge({ name: "scorecheck_service_healthy", help: "Docker health state: 1 healthy, 0 unhealthy, -1 unavailable.", labelNames: ["agent", "role", "service"], registers: [this.registry] });
  private readonly serviceRestarts = new Gauge({ name: "scorecheck_service_restart_total", help: "Docker restart count.", labelNames: ["agent", "role", "service"], registers: [this.registry] });
  private readonly serviceOom = new Gauge({ name: "scorecheck_service_oom_killed", help: "Whether the container was OOM killed.", labelNames: ["agent", "role", "service"], registers: [this.registry] });
  private readonly serviceMemory = new Gauge({ name: "scorecheck_service_memory_usage_bytes", help: "Container memory usage.", labelNames: ["agent", "role", "service"], registers: [this.registry] });
  private readonly serviceMemoryLimit = new Gauge({ name: "scorecheck_service_memory_limit_bytes", help: "Container memory limit.", labelNames: ["agent", "role", "service"], registers: [this.registry] });
  private readonly serviceCpu = new Gauge({ name: "scorecheck_service_cpu_ratio", help: "Container CPU cores consumed as a ratio where 1 equals one core.", labelNames: ["agent", "role", "service"], registers: [this.registry] });
  private readonly pathReady = new Gauge({ name: "scorecheck_media_path_ready", help: "Whether the media path is ready.", labelNames: ["agent", "court", "branch"], registers: [this.registry] });
  private readonly pathReaders = new Gauge({ name: "scorecheck_media_path_readers", help: "Readers on the media path.", labelNames: ["agent", "court", "branch"], registers: [this.registry] });
  private readonly pathBytesReceived = new Gauge({ name: "scorecheck_media_path_bytes_received_total", help: "Media path cumulative bytes received.", labelNames: ["agent", "court", "branch"], registers: [this.registry] });
  private readonly pathBytesSent = new Gauge({ name: "scorecheck_media_path_bytes_sent_total", help: "Media path cumulative bytes sent.", labelNames: ["agent", "court", "branch"], registers: [this.registry] });
  private readonly pathBitrate = new Gauge({ name: "scorecheck_media_path_inbound_bitrate_bps", help: "Derived inbound bitrate from consecutive byte samples.", labelNames: ["agent", "court", "branch"], registers: [this.registry] });
  private readonly pathFrameErrors = new Gauge({ name: "scorecheck_media_path_frame_errors_total", help: "Media path cumulative inbound frame errors.", labelNames: ["agent", "court", "branch"], registers: [this.registry] });
  private previousErrors = new Set<string>();

  update(snapshot: AgentSnapshot) {
    const base = { agent: snapshot.agentId, role: snapshot.role };
    this.up.set(base, 1);
    this.collectionDuration.set(base, snapshot.collectionDurationMs / 1_000);
    this.hostUptime.set(base, snapshot.host.uptimeSeconds);
    this.hostLoad1.set(base, snapshot.host.load1);
    this.memoryTotal.set(base, snapshot.host.memoryTotalBytes);
    this.memoryAvailable.set(base, snapshot.host.memoryAvailableBytes);
    if (snapshot.host.diskTotalBytes != null) this.diskTotal.set(base, snapshot.host.diskTotalBytes);
    if (snapshot.host.diskFreeBytes != null) this.diskFree.set(base, snapshot.host.diskFreeBytes);

    const currentErrors = new Set(snapshot.collectionErrors);
    for (const issueCode of currentErrors) {
      if (!this.previousErrors.has(issueCode)) this.collectionErrors.inc({ ...base, issue_code: issueCode });
    }
    this.previousErrors = currentErrors;

    for (const metric of [this.serviceRunning, this.serviceHealthy, this.serviceRestarts, this.serviceOom, this.serviceMemory, this.serviceMemoryLimit, this.serviceCpu]) metric.reset();
    for (const service of snapshot.services) {
      const labels = { ...base, service: service.name };
      this.serviceRunning.set(labels, service.running ? 1 : 0);
      this.serviceHealthy.set(labels, service.healthy == null ? -1 : service.healthy ? 1 : 0);
      this.serviceRestarts.set(labels, service.restartCount);
      this.serviceOom.set(labels, service.oomKilled ? 1 : 0);
      if (service.memoryUsageBytes != null) this.serviceMemory.set(labels, service.memoryUsageBytes);
      if (service.memoryLimitBytes != null) this.serviceMemoryLimit.set(labels, service.memoryLimitBytes);
      if (service.cpuRatio != null) this.serviceCpu.set(labels, service.cpuRatio);
    }

    for (const metric of [this.pathReady, this.pathReaders, this.pathBytesReceived, this.pathBytesSent, this.pathBitrate, this.pathFrameErrors]) metric.reset();
    for (const path of snapshot.mediaPaths) {
      const labels = { agent: snapshot.agentId, court: String(path.courtNumber), branch: path.branch };
      this.pathReady.set(labels, path.ready ? 1 : 0);
      this.pathReaders.set(labels, path.readerCount);
      this.pathBytesReceived.set(labels, path.bytesReceived);
      this.pathBytesSent.set(labels, path.bytesSent);
      if (path.inboundBitrateBps != null) this.pathBitrate.set(labels, path.inboundBitrateBps);
      this.pathFrameErrors.set(labels, path.frameErrors);
    }
  }
}
