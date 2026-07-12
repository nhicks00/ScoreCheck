import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { acknowledgeMonitorIncident } from "@/lib/monitoring";

const bodySchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const incidentId = z.string().uuid().safeParse(id);
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!incidentId.success || !body.success) return NextResponse.json({ error: "A valid incident and reason are required." }, { status: 400 });
  try {
    return NextResponse.json(await acknowledgeMonitorIncident(incidentId.data, "scorecheck-admin", body.data.reason), {
      headers: { "cache-control": "private, no-store" }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Acknowledgement failed." }, { status: 502 });
  }
}
