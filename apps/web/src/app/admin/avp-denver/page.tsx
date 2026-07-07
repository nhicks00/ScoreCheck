import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { getEnv, missingEnvKeys } from "@/lib/env";
import { getEventBySlug } from "@/lib/eventConfig";
import { supabaseAdmin } from "@/lib/supabase";
import { SetupNotice } from "@/components/SetupNotice";
import { FanScoringDashboard } from "@/components/fan-scoring/FanScoringDashboard";

export const dynamic = "force-dynamic";

export default async function AdminAvpDenverPage() {
  if (!(await isAdminRequest())) redirect("/admin/login");
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
  const event = await getEventBySlug(env.defaultEventSlug, db);
  if (!event) redirect("/admin/events");
  const [courtResult, sessionResult, flagResult] = await Promise.all([
    db.from("courts").select("*, matches:current_match_id(*), score_states(*)").eq("event_id", event.id).order("court_number", { ascending: true }),
    db.from("scorer_sessions").select("*").eq("event_id", event.id).order("joined_at", { ascending: true }),
    db.from("court_flags").select("*").eq("event_id", event.id).order("created_at", { ascending: false }).limit(80)
  ]);
  return (
    <main className="shell">
      <div className="container admin-container stack">
        <div className="topbar">
          <span className="brand-mark">Score<em>Check</em></span>
          <nav className="topbar-nav" aria-label="Admin">
            <Link className="button ghost" href="/admin/events">Events</Link>
            <Link className="button ghost" href={`/admin/events/${event.id}`}>Event setup</Link>
            <form action="/api/admin/logout" method="post"><button type="submit">Logout</button></form>
          </nav>
        </div>
        <FanScoringDashboard
          event={{ id: event.id, name: event.name, slug: event.slug ?? env.defaultEventSlug }}
          courts={courtResult.data ?? []}
          sessions={sessionResult.data ?? []}
          flags={flagResult.data ?? []}
          siteUrl={env.publicSiteUrl}
        />
      </div>
    </main>
  );
}
