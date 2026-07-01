import { ScorerSessionClient } from "./ScorerSessionClient";

export const dynamic = "force-dynamic";

export default async function ScorerSessionPage({ params }: { params: Promise<{ sessionToken: string }> }) {
  const { sessionToken } = await params;
  return <ScorerSessionClient sessionToken={sessionToken} />;
}
