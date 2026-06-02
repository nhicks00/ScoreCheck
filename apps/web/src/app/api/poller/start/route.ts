import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { readFormOrJson } from "@/lib/http";
import { runPollingWindow } from "@/lib/poller";

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const body = await readFormOrJson(req);
  if (!body.eventId) return NextResponse.json({ error: "eventId is required" }, { status: 400 });
  const result = await runPollingWindow(body.eventId, body.courtId || undefined);
  return NextResponse.json(result);
}
