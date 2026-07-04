import { OverlayClient } from "../../../court/[courtNumber]/OverlayClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AvpDenverOverlayPage({ params }: { params: Promise<{ courtNumber: string }> }) {
  const { courtNumber } = await params;
  return <OverlayClient courtNumber={courtNumber} eventId="" theme="default" buildVersion={overlayBuildVersion()} />;
}

function overlayBuildVersion() {
  return process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
    ?? process.env.RENDER_GIT_COMMIT
    ?? "local";
}
