import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { setActiveEvent } from "@/lib/eventConfig";
import { initializeEventMonitoringOff } from "@/lib/monitoringExpectations";

export async function POST(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { eventId } = await params;
  try {
    await initializeEventMonitoringOff(eventId);
    await setActiveEvent(eventId);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not activate event" }, { status: 500 });
  }
  // Back to the switcher so the newly active event is reflected in the UI.
  return NextResponse.redirect(new URL("/admin/events", req.url), { status: 303 });
}
