import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const POSTGRES_IMAGE =
  "postgres@sha256:3d0f7584ed7d04e27fa050d6683a74746608faf21f202be78460d679cc56461f";
const DATABASE = "vision_shadow_test";
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const READINESS_TIMEOUT_MS = 60_000;
const READINESS_PROBE_TIMEOUT_MS = 5_000;
const READINESS_POLL_MS = 500;
const webRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const visionProposalPath = resolve(
  webRoot,
  "supabase/proposals/vision_shadow_receipts.sql"
);
const fixturePath = resolve(
  webRoot,
  "src/scripts/fixtures/visionShadowPostgres.sql"
);

const ROLE_BOOTSTRAP = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key
);

create schema realtime;
create table realtime.send_log (
  id bigint generated always as identity primary key,
  payload jsonb not null,
  event_name text not null,
  topic text not null,
  private boolean not null
);
create function realtime.send(
  p_payload jsonb,
  p_event_name text,
  p_topic text,
  p_private boolean
)
returns void
language sql
security definer
set search_path = pg_catalog, realtime
as $$
  insert into realtime.send_log(payload, event_name, topic, private)
  values (p_payload, p_event_name, p_topic, p_private)
$$;
`;

interface DockerResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
}

function docker(
  arguments_: readonly string[],
  options: { readonly input?: string; readonly timeoutMs?: number } = {}
): DockerResult {
  const result = spawnSync("docker", [...arguments_], {
    encoding: "utf8",
    input: options.input,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
    timeout: options.timeoutMs ?? 120_000
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function commandDetail(result: DockerResult): string {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const bounded = output.slice(-12_000);
  if (result.error) return `${result.error.message}${bounded ? `\n${bounded}` : ""}`;
  return bounded || `docker exited with status ${String(result.status)}`;
}

function requireSuccess(label: string, result: DockerResult): void {
  if (result.status !== 0 || result.error) {
    throw new Error(`VISION_POSTGRES_${label}: ${commandDetail(result)}`);
  }
}

function removeContainerIfPresent(containerName: string): void {
  const inspect = docker(["container", "inspect", containerName], { timeoutMs: 15_000 });
  if (inspect.status === 0 && !inspect.error) {
    requireSuccess(
      "CLEANUP_FAILED",
      docker(["rm", "--force", containerName], { timeoutMs: 30_000 })
    );
    return;
  }
  if (inspect.error) {
    throw new Error(`VISION_POSTGRES_CLEANUP_INSPECT_FAILED: ${commandDetail(inspect)}`);
  }
  if (
    inspect.status === 1 &&
    /no such (?:object|container)/i.test(`${inspect.stdout}\n${inspect.stderr}`)
  ) {
    return;
  }
  throw new Error(`VISION_POSTGRES_CLEANUP_INSPECT_FAILED: ${commandDetail(inspect)}`);
}

function runPsql(
  containerName: string,
  label: string,
  sql: string,
  singleTransaction = true
): DockerResult {
  const arguments_ = [
    "exec",
    "--interactive",
    containerName,
    "psql",
    "--no-psqlrc",
    "--username",
    "postgres",
    "--dbname",
    DATABASE,
    "--set=ON_ERROR_STOP=1"
  ];
  if (singleTransaction) arguments_.push("--single-transaction");
  arguments_.push("--file=-");
  const result = docker(arguments_, { input: sql });
  requireSuccess(label, result);
  return result;
}

function expectPermissionDenied(
  containerName: string,
  label: string,
  sql: string
): void {
  const result = docker(
    [
      "exec",
      "--interactive",
      containerName,
      "psql",
      "--no-psqlrc",
      "--username",
      "postgres",
      "--dbname",
      DATABASE,
      "--set=ON_ERROR_STOP=1",
      "--file=-"
    ],
    { input: `\\set VERBOSITY verbose\n${sql}\n` }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.error) {
    throw new Error(
      `VISION_POSTGRES_${label}: Docker/psql invocation failed before PostgreSQL denial\n${commandDetail(result)}`
    );
  }
  if (result.status === 0) {
    throw new Error(`VISION_POSTGRES_${label}: operation unexpectedly succeeded`);
  }
  if (result.status !== 3 || !/ERROR:\s+42501:/m.test(output)) {
    throw new Error(
      `VISION_POSTGRES_${label}: expected exact PostgreSQL SQLSTATE 42501\n${commandDetail(result)}`
    );
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function loadExecutableMigrations(): Array<{
  readonly fileName: string;
  readonly version: number;
  readonly sql: string;
}> {
  const migrationDirectory = resolve(webRoot, "supabase/migrations");
  const sqlFiles = readdirSync(migrationDirectory)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  const invalidFiles = sqlFiles.filter((fileName) => !/^\d{3}_.+\.sql$/.test(fileName));
  if (invalidFiles.length > 0) {
    throw new Error(
      `VISION_POSTGRES_EXECUTABLE_MIGRATION_NAME_INVALID: ${invalidFiles.join(",")}`
    );
  }
  const migrations = sqlFiles.map((fileName) => ({
    fileName,
    version: Number(fileName.slice(0, 3)),
    sql: readFileSync(resolve(migrationDirectory, fileName), "utf8")
  }));
  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1]!;
    const current = migrations[index]!;
    if (current.version <= previous.version) {
      throw new Error(
        `VISION_POSTGRES_EXECUTABLE_MIGRATION_VERSION_INVALID: ${previous.fileName},${current.fileName}`
      );
    }
  }
  return migrations;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitUntilReady(containerName: string): Promise<void> {
  let lastResult: DockerResult | null = null;
  const deadline = performance.now() + READINESS_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const probeBudget = Math.max(
      1,
      Math.min(
        READINESS_PROBE_TIMEOUT_MS,
        Math.ceil(deadline - performance.now())
      )
    );
    lastResult = docker(
      [
        "exec",
        containerName,
        "pg_isready",
        "--username",
        "postgres",
        "--dbname",
        DATABASE
      ],
      { timeoutMs: probeBudget }
    );
    if (lastResult.status === 0 && !lastResult.error) return;
    const remaining = deadline - performance.now();
    if (remaining > 0) {
      await sleep(Math.min(READINESS_POLL_MS, remaining));
    }
  }
  throw new Error(
    `VISION_POSTGRES_START_TIMEOUT: ${lastResult ? commandDetail(lastResult) : "no readiness result"}`
  );
}

function assertDockerDaemon(): void {
  const result = docker(["version", "--format", "{{.Server.Version}}"], {
    timeoutMs: 15_000
  });
  if (result.status === 0 && !result.error) return;
  const missingCli = (result.error as (Error & { code?: string }) | undefined)?.code === "ENOENT";
  const guidance = missingCli
    ? "install the Docker CLI"
    : "start the existing Docker/Colima daemon; this harness will not start it";
  throw new Error(`VISION_POSTGRES_DOCKER_UNAVAILABLE: ${guidance}\n${commandDetail(result)}`);
}

const DENIAL_CASES = [
  {
    label: "INGEST_TABLE_DENIAL",
    sql: "set role vision_shadow_ingest; select count(*) from public.vision_shadow_receipts;"
  },
  {
    label: "PUBLISHER_TABLE_DENIAL",
    sql: "set role vision_shadow_binding_publisher; select count(*) from public.vision_match_bindings;"
  },
  {
    label: "READER_TABLE_DENIAL",
    sql: "set role vision_shadow_reader; select count(*) from public.vision_shadow_receipts;"
  },
  {
    label: "INGEST_OFFICIAL_SCORE_DENIAL",
    sql: "set role vision_shadow_ingest; insert into public.score_states default values;"
  },
  {
    label: "PUBLISHER_OFFICIAL_SCORE_DENIAL",
    sql: "set role vision_shadow_binding_publisher; insert into public.score_states default values;"
  },
  {
    label: "READER_OFFICIAL_SCORE_DENIAL",
    sql: "set role vision_shadow_reader; insert into public.score_states default values;"
  },
  {
    label: "INGEST_READ_RPC_DENIAL",
    sql: "set role vision_shadow_ingest; select * from public.vision_read_shadow_receipts('ledger-1', 'match-1');"
  },
  {
    label: "PUBLISHER_INGEST_RPC_DENIAL",
    sql: "set role vision_shadow_binding_publisher; select * from public.vision_accept_shadow_receipt(decode('00', 'hex'), decode('00', 'hex'), 0);"
  },
  {
    label: "READER_PUBLISH_RPC_DENIAL",
    sql: `set role vision_shadow_reader;
      select public.vision_publish_match_binding(
        'ledger-x', 'match-x',
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        100, repeat('a', 64), 90
      );`
  },
  {
    label: "SERVICE_ROLE_BROADCAST_EXECUTE_DENIAL",
    sql: "set role service_role; select public.broadcast_overlay_state_change();"
  }
] as const;

async function run(): Promise<void> {
  const executableMigrations = loadExecutableMigrations();
  assertDockerDaemon();
  const containerName =
    `multicourt-vision-pg-${process.pid}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const visionProposal = readFileSync(visionProposalPath, "utf8");
  const fixture = readFileSync(fixturePath, "utf8");
  let failure: unknown = null;
  let handlingSignal = false;
  const signalExitCodes = {
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143
  } as const;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (handlingSignal) return;
      handlingSignal = true;
      try {
        removeContainerIfPresent(containerName);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
      process.exit(signalExitCodes[signal]);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    // Idempotent preflight cleanup protects against a prior interrupted run,
    // even though every invocation also receives a collision-resistant name.
    removeContainerIfPresent(containerName);
    const start = docker(
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        containerName,
        "--network=none",
        "--env",
        "POSTGRES_PASSWORD=vision-shadow-local-only",
        "--env",
        `POSTGRES_DB=${DATABASE}`,
        POSTGRES_IMAGE
      ],
      { timeoutMs: 300_000 }
    );
    requireSuccess("CONTAINER_START_FAILED", start);
    await waitUntilReady(containerName);

    runPsql(containerName, "ROLE_BOOTSTRAP_FAILED", ROLE_BOOTSTRAP);
    for (const migration of executableMigrations) {
      runPsql(
        containerName,
        `EXECUTABLE_MIGRATION_${migration.fileName.slice(0, 3)}_FAILED`,
        migration.sql
      );
    }
    runPsql(containerName, "VISION_PROPOSAL_FAILED", visionProposal);
    runPsql(containerName, "BEHAVIOR_FIXTURE_FAILED", fixture);
    for (const denial of DENIAL_CASES) {
      expectPermissionDenied(containerName, denial.label, denial.sql);
    }

    console.log(
      [
        "Vision PostgreSQL integration passed.",
        `image=${POSTGRES_IMAGE}`,
        `executable_migration_count=${executableMigrations.length}`,
        `executable_chain_sha256=${sha256(
          executableMigrations.map((migration) => migration.sql).join("\n")
        )}`,
        `vision_proposal_sha256=${sha256(visionProposal)}`,
        `denial_cases=${DENIAL_CASES.length}`
      ].join("\n")
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      // This runs even when `docker run` times out after creating the container.
      removeContainerIfPresent(containerName);
    } catch (error) {
      if (failure === null) failure = error;
      else console.error(error instanceof Error ? error.message : String(error));
    }
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  }

  if (failure instanceof Error) throw failure;
  if (failure !== null) throw new Error(`VISION_POSTGRES_UNKNOWN_FAILURE: ${String(failure)}`);
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
