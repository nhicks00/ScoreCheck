import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { loadAdminCourtsWithCurrentScores } from "@/lib/adminCourtData";
import { getEnv, missingEnvKeys } from "@/lib/env";
import { getActiveEvent } from "@/lib/eventConfig";
import { supabaseAdmin } from "@/lib/supabase";
import { SetupNotice } from "@/components/SetupNotice";
import { FanScoringDashboard, type FanScoringCourt } from "@/components/fan-scoring/FanScoringDashboard";
import { getCommunityAdminAssignmentSummary, listOpenCommunityDisputes } from "@/lib/communityWitness";

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
  // Legacy bookmarked route: resolve the DB-active event, never the Denver slug.
  const event = await getActiveEvent(db);
  if (!event) redirect("/admin/events");
  const [courts, assignmentSummary, flagResult, disputeResult] = await Promise.all([
    loadAdminCourtsWithCurrentScores<FanScoringCourt>(event.id, db),
    getCommunityAdminAssignmentSummary({ eventId: event.id }),
    db.from("court_flags").select("*").eq("event_id", event.id).order("created_at", { ascending: false }).limit(80),
    listOpenCommunityDisputes({ eventId: event.id })
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
          event={{ id: event.id, name: event.name, slug: event.slug ?? "event" }}
          courts={courts}
          assignments={assignmentSummary.assignments}
          courtCounts={assignmentSummary.courtCounts}
          flags={flagResult.data ?? []}
          disputes={disputeResult.disputes}
          disputeTotalOpenCount={disputeResult.totalOpenCount}
          disputesTruncated={disputeResult.truncated}
          siteUrl={env.publicSiteUrl}
        />
      </div>
    </main>
  );
}
