import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { refreshEventBracketSources } from "@/lib/bracketRefresh";

export async function POST(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { eventId } = await params;
  return NextResponse.json(await refreshEventBracketSources(eventId));
}
