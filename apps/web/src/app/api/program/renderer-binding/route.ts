import { NextResponse } from "next/server";
import {
  PROGRAM_RENDERER_CONTRACTS,
  programRendererBinding,
  programRendererOrigin
} from "@/lib/program";

export const dynamic = "force-dynamic";

export function GET() {
  const binding = programRendererBinding();
  const origin = programRendererOrigin();
  if (!binding || !origin) {
    return NextResponse.json({ error: "Renderer identity unavailable" }, {
      status: 503,
      headers: { "cache-control": "private, no-store" }
    });
  }
  return NextResponse.json({
    schemaVersion: 1,
    provider: "vercel",
    origin,
    deploymentId: binding.deployment,
    gitSha: binding.build,
    assetNamespace: binding.deployment,
    contracts: PROGRAM_RENDERER_CONTRACTS
  }, { headers: { "cache-control": "private, no-store" } });
}
