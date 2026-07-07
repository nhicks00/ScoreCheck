import { NextResponse } from "next/server";
import { missingEnvKeys } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase";
import { workerHeartbeatStale, type WorkerHeartbeatRow } from "@/lib/workerSchedule";

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
    .select("worker_id,status,last_seen_at,metadata")
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const workerStale = workerHeartbeatStale(heartbeat as WorkerHeartbeatRow | null);
  const workerRow = heartbeat as (WorkerHeartbeatRow & { worker_id?: string }) | null;
  return NextResponse.json({
    status: error || heartbeatError || workerStale ? "degraded" : "ok",
    eventCount: count ?? 0,
    database: error ? error.message : "ok",
    worker: heartbeatError
      ? heartbeatError.message
      : workerRow
        ? {
            worker_id: workerRow.worker_id,
            status: workerRow.status,
            last_seen_at: workerRow.last_seen_at,
            stale: workerStale,
            note: typeof workerRow.metadata?.reason === "string" ? workerRow.metadata.reason : undefined
          }
        : null
  });
}
