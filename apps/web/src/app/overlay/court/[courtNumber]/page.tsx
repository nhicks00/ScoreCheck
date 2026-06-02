import { OverlayClient } from "./OverlayClient";

export default async function OverlayPage({ params, searchParams }: {
  params: Promise<{ courtNumber: string }>;
  searchParams: Promise<{ eventId?: string; theme?: string }>;
}) {
  const { courtNumber } = await params;
  const { eventId, theme } = await searchParams;
  return <OverlayClient courtNumber={courtNumber} eventId={eventId ?? ""} theme={theme ?? "default"} />;
}
