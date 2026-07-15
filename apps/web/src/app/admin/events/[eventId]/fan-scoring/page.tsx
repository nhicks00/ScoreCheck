import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { loadAdminCourtsWithCurrentScores } from "@/lib/adminCourtData";
import { getEnv, missingEnvKeys } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase";
import { SetupNotice } from "@/components/SetupNotice";
import { FanScoringDashboard, type FanScoringCourt } from "@/components/fan-scoring/FanScoringDashboard";
import { getCommunityAdminAssignmentSummary, listOpenCommunityDisputes } from "@/lib/communityWitness";

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
  const [eventResult, courts, assignmentSummary, flagResult, disputeResult] = await Promise.all([
    db.from("events").select("*").eq("id", eventId).single(),
    loadAdminCourtsWithCurrentScores<FanScoringCourt>(eventId, db),
    getCommunityAdminAssignmentSummary({ eventId }),
    db.from("court_flags").select("*").eq("event_id", eventId).order("created_at", { ascending: false }).limit(80),
    listOpenCommunityDisputes({ eventId })
  ]);
  if (!eventResult.data) redirect("/admin/events");
  return (
    <main className="shell">
      <div className="container stack">
        <div className="topbar">
          <span className="brand-mark">Score<em>Check</em></span>
          <nav className="topbar-nav" aria-label="Admin">
            <Link className="button ghost" href={`/admin/events/${eventId}`}>Event setup</Link>
            <Link className="button ghost" href="/admin/events">Events</Link>
            <form action="/api/admin/logout" method="post"><button type="submit">Logout</button></form>
          </nav>
        </div>
        <FanScoringDashboard
          event={{ id: eventResult.data.id, name: eventResult.data.name, slug: eventResult.data.slug ?? "event" }}
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
