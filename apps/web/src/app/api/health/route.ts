import { NextResponse } from "next/server";
import { missingEnvKeys } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase";

const WORKER_STALE_MS = 60_000;

export async function GET() {
  const missing = missingEnvKeys();
  if (missing.length) {
    return NextResponse.json({ status: "degraded", missingEnv: missing });
  }

  const db = supabaseAdmin();
  const { count, error } = await db
    .from("events")
    .select("*", { count: "exact", head: true });
  const { data: heartbeat, error: heartbeatError } = await db
    .from("worker_heartbeats")
    .select("worker_id,status,last_seen_at")
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const workerStale = heartbeat?.last_seen_at
    ? Date.now() - new Date(heartbeat.last_seen_at).getTime() > WORKER_STALE_MS
    : true;
  return NextResponse.json({
    status: error || heartbeatError || workerStale ? "degraded" : "ok",
    eventCount: count ?? 0,
    database: error ? error.message : "ok",
    worker: heartbeatError ? heartbeatError.message : heartbeat ? { ...heartbeat, stale: workerStale } : null
  });
}
