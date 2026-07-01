import { ScorerClient } from "./ScorerClient";
import { ClaimClient } from "./ClaimClient";

export const dynamic = "force-dynamic";

export default async function ScoreCourtPage({ params, searchParams }: { params: Promise<{ courtId: string }>; searchParams: Promise<{ token?: string; eventSlug?: string; admin?: string }> }) {
  const { courtId } = await params;
  const { token = "", eventSlug, admin } = await searchParams;
  if (token) {
    return <ScorerClient courtId={courtId} initialToken={token} />;
  }
  return <ClaimClient courtParam={courtId} eventSlug={eventSlug ?? "avp-denver"} adminMode={admin === "1"} />;
}
