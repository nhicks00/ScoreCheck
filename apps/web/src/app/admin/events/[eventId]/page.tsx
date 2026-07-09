import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { getEnv, missingEnvKeys } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase";
import { EventDashboard } from "@/components/EventDashboard";
import { SetupNotice } from "@/components/SetupNotice";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ eventId: string }> }) {
  if (!(await isAdminRequest())) redirect("/admin/login");
  const { eventId } = await params;
  const missing = missingEnvKeys();
  const env = getEnv();

  if (missing.length) {
    return (
      <main className="shell">
        <div className="container stack">
          <div className="topbar">
            <span className="brand-mark">Score<em>Check</em></span>
            <nav className="topbar-nav" aria-label="Admin">
              <Link className="button ghost" href="/admin/events">Events</Link>
            </nav>
          </div>
          <SetupNotice />
        </div>
      </main>
    );
  }

  const db = supabaseAdmin();
  const [eventResult, sourceResult, courtResult, matchResult, queueResult, heartbeatResult, errorResult] = await Promise.all([
    db.from("events").select("*").eq("id", eventId).single(),
    db.from("bracket_sources").select("*").eq("event_id", eventId).order("created_at", { ascending: false }),
    db.from("courts").select("*, matches:current_match_id(*), score_states(*)").eq("event_id", eventId).order("court_number", { ascending: true }),
    db.from("matches").select("*").eq("event_id", eventId).order("scheduled_date", { ascending: true, nullsFirst: false }).order("scheduled_time", { ascending: true, nullsFirst: false }),
    db.from("court_match_queue").select("*, matches:match_id(id,match_number,team_a,team_b,source_type)").eq("event_id", eventId).order("queue_position", { ascending: true }),
    db.from("worker_heartbeats").select("*").order("last_seen_at", { ascending: false }).limit(6),
    db.from("poller_errors").select("*").eq("event_id", eventId).order("created_at", { ascending: false }).limit(20)
  ]);
  if (!eventResult.data) redirect("/admin/events");
  const schemaWarnings = [queueResult.error, heartbeatResult.error, errorResult.error]
    .filter((error): error is NonNullable<typeof queueResult.error> => Boolean(error))
    .map((error) => error.message);

  return (
    <main className="shell">
      <div className="container stack">
        <div className="topbar">
          <span className="brand-mark">Score<em>Check</em></span>
          <nav className="topbar-nav" aria-label="Admin">
            <Link className="button ghost" href="/admin/events">Events</Link>
            <Link className="button ghost" href={`/admin/events/${eventId}/courts`}>Court Grid</Link>
            <form action="/api/admin/logout" method="post"><button type="submit">Logout</button></form>
          </nav>
        </div>
        <EventDashboard
          event={eventResult.data}
          sources={sourceResult.data ?? []}
          courts={courtResult.data ?? []}
          matches={matchResult.data ?? []}
          queues={queueResult.data ?? []}
          heartbeats={heartbeatResult.data ?? []}
          pollerErrors={errorResult.data ?? []}
          schemaWarnings={schemaWarnings}
          siteUrl={env.publicSiteUrl}
          defaultTimezone={env.timezone}
        />
      </div>
    </main>
  );
}
