import { OverlayClient } from "../../../court/[courtNumber]/OverlayClient";

export default async function AvpDenverOverlayPage({ params }: { params: Promise<{ courtNumber: string }> }) {
  const { courtNumber } = await params;
  return <OverlayClient courtNumber={courtNumber} eventId="" theme="default" />;
}
