import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { isValidCourtNumber } from "@/lib/opsConsole";
import { proxyControllerCourtAction } from "@/lib/productionStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stop the broadcast for court :n — admin-guarded proxy to the production
 * controller's POST /courts/:n/stop (infra/controller/src/index.ts). Same
 * offline/unreachable semantics as the start route: 503 when the controller
 * env is unset, 502 when it does not answer.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ n: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;

  const { n } = await params;
  const courtNumber = Number(n);
  if (!isValidCourtNumber(courtNumber)) {
    return NextResponse.json({ error: "Court number must be an integer 1-99" }, { status: 400 });
  }

  const result = await proxyControllerCourtAction(courtNumber, "stop");
  return NextResponse.json(result.body, { status: result.status });
}
