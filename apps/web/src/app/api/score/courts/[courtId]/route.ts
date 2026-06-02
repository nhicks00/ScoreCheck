import { NextRequest } from "next/server";
import { handleManualEdit, handleScorerAction } from "@/lib/manualScoreApi";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const { courtId } = await params;
  return handleManualEdit(req, courtId);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const { courtId } = await params;
  const body = await req.clone().json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "";
  if (action === "toggle-serve" || action === "timeout-a" || action === "timeout-b" || action === "side-switch") {
    return handleScorerAction(req, courtId, action);
  }
  return handleManualEdit(req, courtId);
}
