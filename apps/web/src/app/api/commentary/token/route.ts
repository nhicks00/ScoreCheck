import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createCommentaryConnection } from "@/lib/commentary";
import { isCommentaryRequest } from "@/lib/commentaryAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import { requestIpHash } from "@/lib/security";

export const runtime = "nodejs";

const schema = z.object({
  courtNumber: z.coerce.number().int().min(1).max(8),
  displayName: z.string().trim().min(1).max(80)
});

export async function POST(req: NextRequest) {
  if (!(await isCommentaryRequest(req))) {
    return NextResponse.json({ error: "Commentator login required" }, { status: 401 });
  }
  const ipHash = requestIpHash(req);
  if (!checkRateLimit(`commentary-token:${ipHash}`, 30, 10 * 60_000)) {
    return NextResponse.json({ error: "Too many audio-room requests" }, { status: 429 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Name and court are required" }, { status: 400 });
  try {
    const connection = await createCommentaryConnection({
      courtNumber: parsed.data.courtNumber,
      displayName: parsed.data.displayName,
      role: "commentator"
    });
    return NextResponse.json(connection, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Commentary audio is not ready" }, { status: 503 });
  }
}
