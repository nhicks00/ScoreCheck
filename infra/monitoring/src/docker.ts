import type { ServiceSnapshot } from "./contracts.js";

type DockerContainerListRow = {
  Id?: string;
  Names?: string[];
};

type DockerInspect = {
  RestartCount?: number;
  State?: {
    Running?: boolean;
    OOMKilled?: boolean;
    Health?: { Status?: string };
  };
};

type DockerStats = {
  cpu_stats?: {
    online_cpus?: number;
    system_cpu_usage?: number;
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
  };
  precpu_stats?: {
    system_cpu_usage?: number;
    cpu_usage?: { total_usage?: number };
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
  };
};

export async function collectDockerServices(names: string[], apiUrl: string | null): Promise<ServiceSnapshot[]> {
  if (!names.length) return [];
  if (!apiUrl) throw new Error("Docker API URL is not configured.");
  const rows = await dockerJson<DockerContainerListRow[]>(apiUrl, "/containers/json?all=true");
  const byName = new Map<string, DockerContainerListRow>();
  for (const row of rows) {
    for (const rawName of row.Names ?? []) byName.set(rawName.replace(/^\//, ""), row);
  }

  return Promise.all(names.map(async (name) => {
    const row = byName.get(name);
    if (!row?.Id) return missingService(name);
    const encodedId = encodeURIComponent(row.Id);
    const [inspect, stats] = await Promise.all([
      dockerJson<DockerInspect>(apiUrl, `/containers/${encodedId}/json`),
      dockerJson<DockerStats>(apiUrl, `/containers/${encodedId}/stats?stream=false`).catch(() => null)
    ]);
    return {
      name,
      running: inspect.State?.Running === true,
      healthy: dockerHealth(inspect.State?.Health?.Status),
      restartCount: nonNegativeInteger(inspect.RestartCount),
      oomKilled: inspect.State?.OOMKilled === true,
      memoryUsageBytes: nonNegativeNumberOrNull(stats?.memory_stats?.usage),
      memoryLimitBytes: nonNegativeNumberOrNull(stats?.memory_stats?.limit),
      cpuRatio: dockerCpuRatio(stats)
    };
  }));
}

function missingService(name: string): ServiceSnapshot {
  return {
    name,
    running: false,
    healthy: null,
    restartCount: 0,
    oomKilled: false,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    cpuRatio: null
  };
}

function dockerHealth(status: string | undefined): boolean | null {
  if (status === "healthy") return true;
  if (status === "unhealthy") return false;
  return null;
}

function dockerCpuRatio(stats: DockerStats | null): number | null {
  const cpuTotal = stats?.cpu_stats?.cpu_usage?.total_usage;
  const previousCpuTotal = stats?.precpu_stats?.cpu_usage?.total_usage;
  const systemTotal = stats?.cpu_stats?.system_cpu_usage;
  const previousSystemTotal = stats?.precpu_stats?.system_cpu_usage;
  if ([cpuTotal, previousCpuTotal, systemTotal, previousSystemTotal].some((value) => typeof value !== "number")) return null;
  const cpuDelta = (cpuTotal as number) - (previousCpuTotal as number);
  const systemDelta = (systemTotal as number) - (previousSystemTotal as number);
  if (cpuDelta < 0 || systemDelta <= 0) return null;
  const cpus = stats?.cpu_stats?.online_cpus ?? stats?.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
  return (cpuDelta / systemDelta) * Math.max(1, cpus);
}

async function dockerJson<T>(apiUrl: string, path: string): Promise<T> {
  const response = await fetch(new URL(path, `${apiUrl.replace(/\/+$/, "")}/`), {
    signal: AbortSignal.timeout(2_500)
  });
  if (!response.ok) throw new Error(`Docker API returned ${response.status}.`);
  return response.json() as Promise<T>;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function nonNegativeNumberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
