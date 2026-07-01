import { NextResponse } from "next/server";
import { z } from "zod";
import { heartbeatSession } from "@/lib/scorerSessions";

const schema = z.object({
  connectionStatus: z.string().max(40).optional(),
  watchMode: z.enum(["website", "courtside"]).optional()
});

export async function POST(req: Request, { params }: { params: Promise<{ sessionToken: string }> }) {
  const { sessionToken } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid heartbeat" }, { status: 400 });
  const result = await heartbeatSession(sessionToken, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
