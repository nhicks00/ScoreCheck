import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { getEnv } from "../../lib/env";
import { loadLocalEnv } from "../envLoader";
import { communityMediaReadiness } from "./communityMediaReadiness";

type CheckStatus = "ok" | "missing" | "failing";

const cliChecks = {
  supabase: toolOk("supabase"),
  vercel: toolOk("vercel")
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

async function main() {
  loadLocalEnv();
  const env = getEnv();
  const communityMedia = communityMediaReadiness({ env, rawEnv: process.env });

  const checks: Array<readonly [string, CheckStatus]> = [
    ["Supabase URL", env.supabaseUrl ? "ok" : "missing"],
    ["Supabase anon key", env.supabaseAnonKey ? "ok" : "missing"],
    ["Supabase service role", env.supabaseServiceRoleKey ? "ok" : "missing"],
    ["Supabase service role API access", await supabaseApiAccessStatus(env.supabaseUrl, env.supabaseServiceRoleKey)],
    ["Admin secret", env.adminSecret ? "ok" : "missing"],
    ["StreamRun API key", process.env.STREAMRUN_API_KEY ? "ok" : "missing"],
    ["StreamRun configuration ID", process.env.STREAMRUN_CONFIGURATION_ID ? "ok" : "missing"],
    ["MediaMTX WHEP/HLS base URL", env.mediamtxWhepBaseUrl || env.mediamtxHlsBaseUrl ? "ok" : "missing"],
    ["MediaMTX RTMP ingest base", env.mediamtxRtmpIngestBase ? "ok" : "missing"],
    ["Community media broker and cleanup worker", communityMedia.status === "ok" ? "ok" : "failing"],
    ["Supabase CLI", cliChecks.supabase ? "ok" : "missing"],
    ["Vercel CLI", cliChecks.vercel ? "ok" : "missing"],
    ["Local setup env", fs.existsSync(".env.setup.local") || fs.existsSync(".env.local") ? "ok" : "missing"]
  ];

  for (const [label, status] of checks) {
    console.log(`${status} - ${label}`);
  }
  for (const issue of communityMedia.issues) {
    console.log(`failing - Community media: ${issue}`);
  }

  if (checks.some(([, status]) => status !== "ok")) {
    process.exitCode = 1;
  }
}

function commandOk(cmd: string, args: string[]) {
  try {
    execFileSync(cmd, args, {
      env: cmd === "npx" ? withoutNpmLifecycleEnv() : process.env,
      stdio: "ignore",
      timeout: 20_000
    });
    return true;
  } catch {
    return false;
  }
}

function toolOk(cmd: string) {
  return commandOk(cmd, ["--version"]) || npxToolOk(cmd);
}

function npxToolOk(cmd: string) {
  try {
    execFileSync("bash", ["-lc", `npx --yes ${cmd} --version`], {
      env: withoutNpmLifecycleEnv(),
      stdio: "ignore",
      timeout: 20_000
    });
    return true;
  } catch {
    return false;
  }
}

function withoutNpmLifecycleEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith("npm_")) {
      delete env[key];
    }
  }
  return env;
}

async function supabaseApiAccessStatus(supabaseUrl: string, serviceRoleKey: string): Promise<CheckStatus> {
  if (!supabaseUrl || !serviceRoleKey) return "missing";
  try {
    const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/`, {
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`
      }
    });
    return res.ok ? "ok" : "failing";
  } catch {
    return "failing";
  }
}
