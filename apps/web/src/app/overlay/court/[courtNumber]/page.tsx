import { OverlayClient } from "./OverlayClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function OverlayPage({ params, searchParams }: {
  params: Promise<{ courtNumber: string }>;
  searchParams: Promise<{ eventId?: string; theme?: string }>;
}) {
  const { courtNumber } = await params;
  const { eventId, theme } = await searchParams;
  return <OverlayClient courtNumber={courtNumber} eventId={eventId ?? ""} theme={theme ?? "default"} buildVersion={overlayBuildVersion()} />;
}

function overlayBuildVersion() {
  return process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
    ?? process.env.RENDER_GIT_COMMIT
    ?? "local";
}
