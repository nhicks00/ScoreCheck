import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { getEnv, missingEnvKeys } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase";
import { SetupNotice } from "@/components/SetupNotice";
import { FanScoringDashboard } from "@/components/fan-scoring/FanScoringDashboard";

export const dynamic = "force-dynamic";

export default async function EventFanScoringPage({ params }: { params: Promise<{ eventId: string }> }) {
  if (!(await isAdminRequest())) redirect("/admin/login");
  const { eventId } = await params;
  const missing = missingEnvKeys();
  const env = getEnv();
  if (missing.length) {
    return (
      <main className="shell">
        <div className="container stack">
          <Link className="button" href="/admin/events">Events</Link>
          <SetupNotice />
        </div>
      </main>
    );
  }
  const db = supabaseAdmin();
  const [eventResult, courtResult, sessionResult, flagResult] = await Promise.all([
    db.from("events").select("*").eq("id", eventId).single(),
    db.from("courts").select("*, matches:current_match_id(*), score_states(*)").eq("event_id", eventId).order("court_number", { ascending: true }),
    db.from("scorer_sessions").select("*").eq("event_id", eventId).order("joined_at", { ascending: true }),
    db.from("court_flags").select("*").eq("event_id", eventId).order("created_at", { ascending: false }).limit(80)
  ]);
  if (!eventResult.data) redirect("/admin/events");
  return (
    <main className="shell">
      <div className="container stack">
        <div className="topbar">
          <Link className="button" href={`/admin/events/${eventId}`}>Event setup</Link>
          <Link className="button" href="/admin/avp-denver">AVP Denver</Link>
          <form action="/api/admin/logout" method="post"><button type="submit">Logout</button></form>
        </div>
        <FanScoringDashboard
          event={{ id: eventResult.data.id, name: eventResult.data.name, slug: eventResult.data.slug ?? "event" }}
          courts={courtResult.data ?? []}
          sessions={sessionResult.data ?? []}
          flags={flagResult.data ?? []}
          siteUrl={env.publicSiteUrl}
        />
      </div>
    </main>
  );
}
