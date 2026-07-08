import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { isValidCourtNumber } from "@/lib/opsConsole";
import { proxyControllerCourtAction } from "@/lib/productionStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start the broadcast for court :n — admin-guarded proxy to the production
 * controller's POST /courts/:n/start (infra/controller/src/index.ts). The
 * controller credentials stay server-side; the court's YouTube key is looked
 * up in Supabase by the proxy and never accepted from the client. 503 with a
 * clear message when CONTROLLER_URL/CONTROLLER_TOKEN are unset (the expected
 * pre-fleet state), 502 when the controller is configured but unreachable.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ n: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;

  const { n } = await params;
  const courtNumber = Number(n);
  if (!isValidCourtNumber(courtNumber)) {
    return NextResponse.json({ error: "Court number must be an integer 1-99" }, { status: 400 });
  }

  const result = await proxyControllerCourtAction(courtNumber, "start");
  return NextResponse.json(result.body, { status: result.status });
}
