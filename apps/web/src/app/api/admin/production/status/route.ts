import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { missingEnvKeys } from "@/lib/env";
import { checkController, checkMediamtxPreview, loadProductionSnapshot } from "@/lib/productionStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Polled by /admin/production (~10s): court grid data (match/score snapshots,
 * program heartbeats, masked YouTube keys) plus the health-board probes —
 * worker staleness, controller reachability, and MediaMTX ("video server")
 * reachability. Probes run in parallel with 2s timeouts so a dead droplet
 * slows this route by at most one probe window.
 */
export async function GET(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;

  const missing = missingEnvKeys();
  if (missing.length) {
    return NextResponse.json({ error: `Missing environment variables: ${missing.join(", ")}` }, { status: 503 });
  }

  try {
    const [snapshot, controller, mediamtx] = await Promise.all([
      loadProductionSnapshot(),
      checkController(),
      checkMediamtxPreview()
    ]);
    return NextResponse.json({ ...snapshot, controller, mediamtx });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load production status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
