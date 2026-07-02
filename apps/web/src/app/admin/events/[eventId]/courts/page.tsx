import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { getEnv, missingEnvKeys } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function CourtsPage({ params }: { params: Promise<{ eventId: string }> }) {
  if (!(await isAdminRequest())) redirect("/admin/login");
  const { eventId } = await params;
  if (missingEnvKeys().length) redirect(`/admin/events/${eventId}`);
  const env = getEnv();
  const { data: courts } = await supabaseAdmin()
    .from("courts")
    .select("*, matches:current_match_id(*), score_states(*)")
    .eq("event_id", eventId)
    .order("court_number", { ascending: true });

  return (
    <main className="shell">
      <div className="container stack">
        <div className="topbar">
          <Link className="button" href={`/admin/events/${eventId}`}>Dashboard</Link>
        </div>
        <header className="row wrap">
          <div>
            <h1>Court Grid</h1>
            <p className="muted">Current match, score, and overlay URL status by court.</p>
          </div>
        </header>
        <section className="grid courts">
          {(courts ?? []).map((court) => {
            const match = Array.isArray(court.matches) ? court.matches[0] : court.matches;
            const score = Array.isArray(court.score_states) ? court.score_states[0] : court.score_states;
            const overlayUrl = `${env.publicSiteUrl.replace(/\/$/, "")}/overlay/stream/${court.court_number}`;
            const eventOverlayUrl = `${env.publicSiteUrl.replace(/\/$/, "")}/overlay/court/${court.court_number}?eventId=${eventId}`;
            return (
              <article className="panel stack" key={court.id}>
                <div className="row">
                  <h2>{court.display_name}</h2>
                  <span className={`status ${score?.stale ? "stale" : court.status}`}>{score?.stale ? "stale" : court.status}</span>
                </div>
                <p>{match ? `${match.team_a ?? "Team A"} vs ${match.team_b ?? "Team B"}` : "No active match"}</p>
                <h3>{score ? `${score.team_a_score}-${score.team_b_score}` : "0-0"}</h3>
                <p className="muted">Last poll: {score?.last_api_poll_at ?? "never"}</p>
                <code>{overlayUrl}</code>
                <p className="muted">Event-specific: {eventOverlayUrl}</p>
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}
