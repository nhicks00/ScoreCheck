import { ScorerClient } from "./ScorerClient";

export const dynamic = "force-dynamic";

export default async function ScoreCourtPage({ params, searchParams }: { params: Promise<{ courtId: string }>; searchParams: Promise<{ token?: string }> }) {
  const { courtId } = await params;
  const { token = "" } = await searchParams;
  return <ScorerClient courtId={courtId} initialToken={token} />;
}
