import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { loadMonitorSnapshotWithFallback } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await loadMonitorSnapshotWithFallback(), {
      headers: { "cache-control": "private, no-store" }
    });
  } catch {
    return NextResponse.json({ error: "Monitoring data is unavailable." }, { status: 503 });
  }
}
