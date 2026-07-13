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
  private readonly transportMetricsAvailable = new Gauge({ name: "scorecheck_media_transport_metrics_available", help: "Whether protocol-specific source transport metrics are available.", labelNames: ["agent", "court", "branch", "protocol"], registers: [this.registry] });
  private readonly transportRtt = new Gauge({ name: "scorecheck_media_transport_rtt_ms", help: "Source transport round-trip time in milliseconds.", labelNames: ["agent", "court", "branch", "protocol"], registers: [this.registry] });
  private readonly transportPacketsReceived = new Gauge({ name: "scorecheck_media_transport_packets_received_total", help: "Source transport cumulative received packets.", labelNames: ["agent", "court", "branch", "protocol"], registers: [this.registry] });
  private readonly transportPacketsLost = new Gauge({ name: "scorecheck_media_transport_packets_lost_total", help: "Source transport cumulative lost packets.", labelNames: ["agent", "court", "branch", "protocol"], registers: [this.registry] });
  private readonly transportPacketsRetransmitted = new Gauge({ name: "scorecheck_media_transport_packets_retransmitted_total", help: "Source transport cumulative retransmitted packets.", labelNames: ["agent", "court", "branch", "protocol"], registers: [this.registry] });
  private readonly transportPacketsDropped = new Gauge({ name: "scorecheck_media_transport_packets_dropped_total", help: "Source transport cumulative dropped packets.", labelNames: ["agent", "court", "branch", "protocol"], registers: [this.registry] });
  private readonly transportReceiveRate = new Gauge({ name: "scorecheck_media_transport_receive_rate_bps", help: "Source transport receive rate in bits per second.", labelNames: ["agent", "court", "branch", "protocol"], registers: [this.registry] });
  private readonly transportReceiveBuffer = new Gauge({ name: "scorecheck_media_transport_receive_buffer_ms", help: "Source transport receive buffer in milliseconds.", labelNames: ["agent", "court", "branch", "protocol"], registers: [this.registry] });
  private readonly transportConfiguredLatency = new Gauge({ name: "scorecheck_media_transport_configured_latency_ms", help: "Configured source transport latency in milliseconds.", labelNames: ["agent", "court", "branch", "protocol"], registers: [this.registry] });
  private readonly ffmpegProgressFresh = new Gauge({ name: "scorecheck_ffmpeg_progress_fresh", help: "Whether FFmpeg branch progress has updated within twenty seconds.", labelNames: ["agent", "court", "branch"], registers: [this.registry] });
  private readonly ffmpegFps = new Gauge({ name: "scorecheck_ffmpeg_frames_per_second", help: "FFmpeg branch output frames per second.", labelNames: ["agent", "court", "branch"], registers: [this.registry] });
  private readonly ffmpegBitrate = new Gauge({ name: "scorecheck_ffmpeg_output_bitrate_bps", help: "FFmpeg branch reported output bitrate in bits per second.", labelNames: ["agent", "court", "branch"], registers: [this.registry] });
  private readonly ffmpegDropped = new Gauge({ name: "scorecheck_ffmpeg_dropped_frames", help: "FFmpeg branch cumulative dropped frames for the current process.", labelNames: ["agent", "court", "branch"], registers: [this.registry] });
  private readonly ffmpegDuplicated = new Gauge({ name: "scorecheck_ffmpeg_duplicated_frames", help: "FFmpeg branch cumulative duplicated frames for the current process.", labelNames: ["agent", "court", "branch"], registers: [this.registry] });
  private readonly ffmpegSpeed = new Gauge({ name: "scorecheck_ffmpeg_speed_ratio", help: "FFmpeg processing speed where one equals real time.", labelNames: ["agent", "court", "branch"], registers: [this.registry] });
  private readonly nativeEndpointUp = new Gauge({ name: "scorecheck_native_endpoint_up", help: "Whether an allowlisted local native metrics or health endpoint is reachable.", labelNames: ["agent", "role", "service"], registers: [this.registry] });
  private readonly livekitRooms = new Gauge({ name: "scorecheck_livekit_rooms", help: "Current LiveKit room count.", labelNames: ["agent"], registers: [this.registry] });
  private readonly livekitParticipants = new Gauge({ name: "scorecheck_livekit_participants", help: "Current LiveKit participant count.", labelNames: ["agent"], registers: [this.registry] });
  private readonly livekitPacketsOut = new Gauge({ name: "scorecheck_livekit_packets_out", help: "LiveKit node outbound packet count.", labelNames: ["agent"], registers: [this.registry] });
  private readonly livekitPacketsDropped = new Gauge({ name: "scorecheck_livekit_packets_dropped", help: "LiveKit node dropped packet count.", labelNames: ["agent"], registers: [this.registry] });
  private readonly compositorCourtAssignment = new Gauge({ name: "scorecheck_compositor_court_assignment", help: "Static compositor-to-court ownership used to scope Egress alerts.", labelNames: ["agent", "court"], registers: [this.registry] });
  private readonly egressIdle = new Gauge({ name: "scorecheck_egress_idle", help: "Whether the Egress worker currently has no active request.", labelNames: ["agent"], registers: [this.registry] });
  private readonly egressMetricsValid = new Gauge({ name: "scorecheck_egress_metrics_valid", help: "Whether required Egress state metrics were collected successfully.", labelNames: ["agent"], registers: [this.registry] });
  private readonly egressCanAccept = new Gauge({ name: "scorecheck_egress_can_accept_request", help: "Whether the Egress worker can admit another request.", labelNames: ["agent"], registers: [this.registry] });
  private readonly egressCgroupMemory = new Gauge({ name: "scorecheck_egress_cgroup_memory_bytes", help: "Egress worker cgroup memory usage.", labelNames: ["agent"], registers: [this.registry] });
  private readonly egressCpuLoad = new Gauge({ name: "scorecheck_egress_cpu_load_ratio", help: "Egress worker CPU admission load ratio.", labelNames: ["agent"], registers: [this.registry] });
  private readonly egressMemoryLoad = new Gauge({ name: "scorecheck_egress_memory_load_ratio", help: "Egress worker memory admission load ratio.", labelNames: ["agent"], registers: [this.registry] });
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
    for (const metric of [this.transportMetricsAvailable, this.transportRtt, this.transportPacketsReceived, this.transportPacketsLost, this.transportPacketsRetransmitted, this.transportPacketsDropped, this.transportReceiveRate, this.transportReceiveBuffer, this.transportConfiguredLatency]) metric.reset();
    if (snapshot.role === "mediamtx") {
      for (let court = 1; court <= 8; court += 1) {
        for (const branch of ["raw", "preview", "program"] as const) {
          const labels = { agent: snapshot.agentId, court: String(court), branch };
          this.pathReady.set(labels, 0);
          this.pathReaders.set(labels, 0);
          this.pathBytesReceived.set(labels, 0);
          this.pathBytesSent.set(labels, 0);
          this.pathBitrate.set(labels, 0);
          this.pathFrameErrors.set(labels, 0);
        }
      }
    }
    for (const path of snapshot.mediaPaths) {
      const labels = { agent: snapshot.agentId, court: String(path.courtNumber), branch: path.branch };
      this.pathReady.set(labels, path.ready ? 1 : 0);
      this.pathReaders.set(labels, path.readerCount);
      this.pathBytesReceived.set(labels, path.bytesReceived);
      this.pathBytesSent.set(labels, path.bytesSent);
      if (path.inboundBitrateBps != null) this.pathBitrate.set(labels, path.inboundBitrateBps);
      this.pathFrameErrors.set(labels, path.frameErrors);
      if (path.sourceProtocol) {
        const transportLabels = { ...labels, protocol: path.sourceProtocol };
        this.transportMetricsAvailable.set(transportLabels, path.transport ? 1 : 0);
        if (path.transport?.rttMs != null) this.transportRtt.set(transportLabels, path.transport.rttMs);
        if (path.transport?.packetsReceived != null) this.transportPacketsReceived.set(transportLabels, path.transport.packetsReceived);
        if (path.transport?.packetsLost != null) this.transportPacketsLost.set(transportLabels, path.transport.packetsLost);
        if (path.transport?.packetsRetransmitted != null) this.transportPacketsRetransmitted.set(transportLabels, path.transport.packetsRetransmitted);
        if (path.transport?.packetsDropped != null) this.transportPacketsDropped.set(transportLabels, path.transport.packetsDropped);
        if (path.transport?.receiveRateBps != null) this.transportReceiveRate.set(transportLabels, path.transport.receiveRateBps);
        if (path.transport?.receiveBufferMs != null) this.transportReceiveBuffer.set(transportLabels, path.transport.receiveBufferMs);
        if (path.transport?.configuredLatencyMs != null) this.transportConfiguredLatency.set(transportLabels, path.transport.configuredLatencyMs);
      }
    }

    for (const metric of [this.ffmpegProgressFresh, this.ffmpegFps, this.ffmpegBitrate, this.ffmpegDropped, this.ffmpegDuplicated, this.ffmpegSpeed]) metric.reset();
    if (snapshot.role === "mediamtx") {
      for (let court = 1; court <= 8; court += 1) {
        for (const branch of ["preview", "program", "calibration", "monitor"] as const) {
          const labels = { agent: snapshot.agentId, court: String(court), branch };
          this.ffmpegProgressFresh.set(labels, 0);
          this.ffmpegFps.set(labels, 0);
          this.ffmpegBitrate.set(labels, 0);
          this.ffmpegDropped.set(labels, 0);
          this.ffmpegDuplicated.set(labels, 0);
          this.ffmpegSpeed.set(labels, 0);
        }
      }
    }
    for (const branch of snapshot.ffmpegBranches) {
      const labels = { agent: snapshot.agentId, court: String(branch.courtNumber), branch: branch.branch };
      this.ffmpegProgressFresh.set(labels, 1);
      if (branch.framesPerSecond != null) this.ffmpegFps.set(labels, branch.framesPerSecond);
      if (branch.bitrateBps != null) this.ffmpegBitrate.set(labels, branch.bitrateBps);
      this.ffmpegDropped.set(labels, branch.droppedFrames);
      this.ffmpegDuplicated.set(labels, branch.duplicatedFrames);
      if (branch.speedRatio != null) this.ffmpegSpeed.set(labels, branch.speedRatio);
    }

    this.nativeEndpointUp.reset();
    for (const endpoint of snapshot.nativeServices.endpoints) {
      this.nativeEndpointUp.set({ ...base, service: endpoint.service }, endpoint.up ? 1 : 0);
    }
    this.compositorCourtAssignment.reset();
    if (snapshot.role === "compositor") {
      for (const court of snapshot.assignedCourts) {
        this.compositorCourtAssignment.set({ agent: snapshot.agentId, court: String(court) }, 1);
      }
    }
    this.livekitRooms.reset();
    this.livekitParticipants.reset();
    this.livekitPacketsOut.reset();
    this.livekitPacketsDropped.reset();
    if (snapshot.nativeServices.livekit) {
      const labels = { agent: snapshot.agentId };
      this.livekitRooms.set(labels, snapshot.nativeServices.livekit.roomCount);
      this.livekitParticipants.set(labels, snapshot.nativeServices.livekit.participantCount);
      this.livekitPacketsOut.set(labels, snapshot.nativeServices.livekit.packetsOut);
      this.livekitPacketsDropped.set(labels, snapshot.nativeServices.livekit.packetsDropped);
    }
    for (const metric of [this.egressIdle, this.egressMetricsValid, this.egressCanAccept, this.egressCgroupMemory, this.egressCpuLoad, this.egressMemoryLoad]) metric.reset();
    if (snapshot.role === "compositor") {
      this.egressMetricsValid.set({ agent: snapshot.agentId }, snapshot.nativeServices.egress ? 1 : 0);
    }
    if (snapshot.nativeServices.egress) {
      const labels = { agent: snapshot.agentId };
      this.egressIdle.set(labels, snapshot.nativeServices.egress.idle ? 1 : 0);
      this.egressCanAccept.set(labels, snapshot.nativeServices.egress.canAcceptRequest ? 1 : 0);
      if (snapshot.nativeServices.egress.cgroupMemoryBytes != null) this.egressCgroupMemory.set(labels, snapshot.nativeServices.egress.cgroupMemoryBytes);
      if (snapshot.nativeServices.egress.cpuLoadRatio != null) this.egressCpuLoad.set(labels, snapshot.nativeServices.egress.cpuLoadRatio);
      if (snapshot.nativeServices.egress.memoryLoadRatio != null) this.egressMemoryLoad.set(labels, snapshot.nativeServices.egress.memoryLoadRatio);
    }
  }
}
