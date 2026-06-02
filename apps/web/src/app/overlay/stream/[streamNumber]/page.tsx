import { OverlayClient } from "../../court/[courtNumber]/OverlayClient";

export default async function StreamOverlayPage({ params, searchParams }: {
  params: Promise<{ streamNumber: string }>;
  searchParams: Promise<{ theme?: string }>;
}) {
  const { streamNumber } = await params;
  const { theme } = await searchParams;
  return <OverlayClient courtNumber={streamNumber} eventId="" theme={theme ?? "default"} />;
}
