import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { scoreForCurrentMatch } from "@/lib/scoreState";
import { supabaseAdmin } from "@/lib/supabase";
import { AdminTopbar } from "@/components/AdminTopbar";

export const dynamic = "force-dynamic";

export default async function CourtPage({ params }: { params: Promise<{ courtId: string }> }) {
  if (!(await isAdminRequest())) redirect("/admin/login");
  const { courtId } = await params;
  const { data: court } = await supabaseAdmin()
    .from("courts")
    .select("*, matches:current_match_id(*), score_states(*)")
    .eq("id", courtId)
    .single();
  if (!court) redirect("/admin/events");
  const match = Array.isArray(court.matches) ? court.matches[0] : court.matches;
  const score = scoreForCurrentMatch(court.score_states, match?.id);
  return (
    <main className="shell">
      <div className="container stack">
        <AdminTopbar />
        <section className="panel stack">
          <h1>{court.display_name}</h1>
          <p className="muted">Mode: {court.mode} | Status: {court.status}</p>
          <p>{match ? `${match.team_a ?? "Team A"} vs ${match.team_b ?? "Team B"}` : "No active match"}</p>
          <h2>{score ? `${score.team_a_score}-${score.team_b_score}` : "0-0"}</h2>
        </section>
      </div>
    </main>
  );
}
