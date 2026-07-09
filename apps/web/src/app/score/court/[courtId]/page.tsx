import { ScorerClient } from "./ScorerClient";
import { ClaimClient } from "./ClaimClient";
import { getActiveEvent } from "@/lib/eventConfig";

export const dynamic = "force-dynamic";

export default async function ScoreCourtPage({ params, searchParams }: { params: Promise<{ courtId: string }>; searchParams: Promise<{ token?: string; eventSlug?: string }> }) {
  const { courtId } = await params;
  const { token = "", eventSlug } = await searchParams;
  if (token) {
    return <ScorerClient courtId={courtId} initialToken={token} />;
  }
  // Resolve the current event from the DB (is_active) rather than a hardcoded
  // slug, so /score/court/N always follows the live event without per-event
  // env changes. An explicit ?eventSlug= wins; there is no env/Denver fallback.
  const resolvedSlug = eventSlug ?? (await getActiveEvent())?.slug ?? "";
  return <ClaimClient courtParam={courtId} eventSlug={resolvedSlug} />;
}
