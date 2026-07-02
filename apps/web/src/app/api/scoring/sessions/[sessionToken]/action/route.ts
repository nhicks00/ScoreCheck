import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { applySessionAction } from "@/lib/scorerSessions";

const schema = z.object({
  actionId: z.string().min(8).max(128).optional(),
  type: z.enum([
    "POINT_A",
    "POINT_B",
    "UNDO",
    "SET_COMPLETE",
    "MATCH_COMPLETE",
    "MANUAL_CORRECTION",
    "SERVE_A",
    "SERVE_B",
    "TIMEOUT_A",
    "TIMEOUT_B",
    "TEAM_NAME_SUGGESTION",
    "RELEASE"
  ]),
  payload: z.record(z.unknown()).optional()
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ sessionToken: string }> }) {
  const { sessionToken } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid scoring action" }, { status: 400 });
  try {
    const result = await applySessionAction(sessionToken, { ...parsed.data, req });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scoring action failed" },
      { status: 400 }
    );
  }
}
