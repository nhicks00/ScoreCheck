import { NextResponse } from "next/server";
import { getSessionState } from "@/lib/scorerSessions";

export async function GET(_req: Request, { params }: { params: Promise<{ sessionToken: string }> }) {
  const { sessionToken } = await params;
  const result = await getSessionState(sessionToken);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.state, { headers: { "cache-control": "no-store" } });
}
