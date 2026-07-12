import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { setEventCompleted } from "@/lib/eventConfig";
import { initializeEventMonitoringOff } from "@/lib/monitoringExpectations";

export async function POST(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { eventId } = await params;
  try {
    await initializeEventMonitoringOff(eventId);
    await setEventCompleted(eventId);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not archive event" }, { status: 500 });
  }
  return NextResponse.redirect(new URL("/admin/events", req.url), { status: 303 });
}
