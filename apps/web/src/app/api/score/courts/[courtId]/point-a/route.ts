import { NextRequest } from "next/server";
import { handleScorerAction } from "@/lib/manualScoreApi";

export async function POST(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const { courtId } = await params;
  return handleScorerAction(req, courtId, "point-a");
}
