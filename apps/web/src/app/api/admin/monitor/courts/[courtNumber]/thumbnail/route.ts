import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { loadMonitorThumbnail } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ courtNumber: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { courtNumber: rawCourt } = await params;
  const courtNumber = Number(rawCourt);
  if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > 8) return new NextResponse(null, { status: 404 });
  try {
    const thumbnail = await loadMonitorThumbnail(courtNumber);
    if (!thumbnail) return new NextResponse(null, { status: 404, headers: { "cache-control": "private, no-store" } });
    return new NextResponse(thumbnail.body, {
      headers: {
        "content-type": thumbnail.contentType,
        "cache-control": "private, no-store",
        ...(thumbnail.sampledAt ? { "x-scorecheck-sampled-at": thumbnail.sampledAt } : {})
      }
    });
  } catch {
    return new NextResponse(null, { status: 502, headers: { "cache-control": "private, no-store" } });
  }
}
