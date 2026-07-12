import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { createMonitorSilence } from "@/lib/monitoring";

const bodySchema = z.object({
  eventId: z.string().uuid().nullable(),
  courtNumber: z.number().int().min(1).max(8).nullable(),
  stage: z.enum(["VENUE", "RAW_INGEST", "PREVIEW", "PROGRAM_PATH", "PROGRAM_BROWSER", "COMMENTARY", "SCORE_SOURCE", "SCORE_RENDER", "EGRESS", "YOUTUBE", "HOST", "CONTROL", "MONITORING", "NOTIFICATION"]).nullable(),
  issueCode: z.string().trim().min(1).max(80).regex(/^[A-Z0-9_.:-]+$/).nullable(),
  reason: z.string().trim().min(3).max(300).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  durationMinutes: z.number().int().refine((value) => [15, 30, 60, 120].includes(value))
}).strict();

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "A valid incident scope, reason, and duration are required." }, { status: 400 });
  const expiresAt = new Date(Date.now() + body.data.durationMinutes * 60_000).toISOString();
  try {
    return NextResponse.json(await createMonitorSilence({
      eventId: body.data.eventId,
      courtNumber: body.data.courtNumber,
      stage: body.data.stage,
      issueCode: body.data.issueCode,
      reason: body.data.reason,
      actor: "scorecheck-admin",
      expiresAt
    }), { status: 201, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Silence failed." }, { status: 502 });
  }
}
