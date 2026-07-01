import { DebugOverlay } from "./DebugOverlay";
import { OverlayClient } from "../../court/[courtNumber]/OverlayClient";

export default async function StreamOverlayPage({ params, searchParams }: {
  params: Promise<{ streamNumber: string }>;
  searchParams: Promise<{ debug?: string; theme?: string }>;
}) {
  const { streamNumber } = await params;
  const { debug, theme } = await searchParams;
  if (debug === "1" || debug === "true") return <DebugOverlay streamNumber={streamNumber} />;
  return <OverlayClient courtNumber={streamNumber} eventId="" theme={theme ?? "default"} />;
}
