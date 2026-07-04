import { DebugOverlay } from "./DebugOverlay";
import { OverlayClient } from "../../court/[courtNumber]/OverlayClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function StreamOverlayPage({ params, searchParams }: {
  params: Promise<{ streamNumber: string }>;
  searchParams: Promise<{ debug?: string; theme?: string }>;
}) {
  const { streamNumber } = await params;
  const { debug, theme } = await searchParams;
  if (debug === "1" || debug === "true") return <DebugOverlay streamNumber={streamNumber} />;
  return <OverlayClient courtNumber={streamNumber} eventId="" theme={theme ?? "default"} buildVersion={overlayBuildVersion()} />;
}

function overlayBuildVersion() {
  return process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
    ?? process.env.RENDER_GIT_COMMIT
    ?? "local";
}
