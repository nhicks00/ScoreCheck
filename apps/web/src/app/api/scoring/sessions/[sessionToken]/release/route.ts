import { NextResponse } from "next/server";
import { releaseSession } from "@/lib/scorerSessions";

export async function POST(_req: Request, { params }: { params: Promise<{ sessionToken: string }> }) {
  const { sessionToken } = await params;
  const result = await releaseSession(sessionToken);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
