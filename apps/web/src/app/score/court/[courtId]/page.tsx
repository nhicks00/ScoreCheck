import { ClaimClient } from "./ClaimClient";
import { getActiveEvent } from "@/lib/eventConfig";

export const dynamic = "force-dynamic";

export default async function ScoreCourtPage({
  params,
  searchParams
}: {
  params: Promise<{ courtId: string }>;
  searchParams: Promise<{ eventSlug?: string; joinCode?: string; role?: string }>;
}) {
  const { courtId } = await params;
  const { eventSlug, joinCode, role } = await searchParams;
  // Resolve the current event from the DB (is_active) rather than a hardcoded
  // slug, so /score/court/N always follows the live event without per-event
  // env changes. An explicit ?eventSlug= wins; there is no env/Denver fallback.
  const resolvedSlug = eventSlug ?? (await getActiveEvent())?.slug ?? "";
  return <ClaimClient courtParam={courtId} eventSlug={resolvedSlug} joinCode={joinCode} roleIntent={role} />;
}
