import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { loadMonitorCourtPipelineRange } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await loadMonitorCourtPipelineRange(), {
      headers: { "cache-control": "private, no-store" }
    });
  } catch {
    return NextResponse.json({ error: "Monitoring history is unavailable." }, { status: 503 });
  }
}
