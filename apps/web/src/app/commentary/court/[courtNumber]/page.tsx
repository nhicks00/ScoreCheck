import { redirect } from "next/navigation";
import { commentaryLiveKitConfigured } from "@/lib/commentary";
import { isCommentaryRequest } from "@/lib/commentaryAuth";
import { getEnv } from "@/lib/env";
import { getActiveEvent } from "@/lib/eventConfig";
import { supabaseAdmin } from "@/lib/supabase";
import { CommentaryCourtClient } from "./CommentaryCourtClient";

export const dynamic = "force-dynamic";

export default async function CommentaryCourtPage({ params }: { params: Promise<{ courtNumber: string }> }) {
  if (!(await isCommentaryRequest())) redirect("/commentary");

  const env = getEnv();
  const { courtNumber: courtParam } = await params;
  const courtNumber = Number(courtParam);
  if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > env.courtCount) redirect("/commentary");

  // Event identity is the DB-resolved active event — never an env slug.
  const supabaseReady = Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
  const event = supabaseReady ? await getActiveEvent() : null;
  if (!event) return <NoActiveEvent />;

  const court = await loadCourt(event.id, courtNumber);

  return (
    <CommentaryCourtClient
      courtNumber={courtNumber}
      courtName={court.displayName ?? `Court ${courtNumber}`}
      eventName={event.name}
      commentaryConfigured={commentaryLiveKitConfigured()}
    />
  );
}

function NoActiveEvent() {
  return (
    <main className="shell">
      <div className="container stack">
        <span className="brand-mark">Score<em>Check</em></span>
        <section className="panel stack">
          <h1>No active event</h1>
          <p className="muted">
            There is no live event right now. Once an event is activated from the admin events page, commentary tools for its
            courts appear here.
          </p>
        </section>
      </div>
    </main>
  );
}

async function loadCourt(eventId: string, courtNumber: number): Promise<{ displayName: string | null }> {
  const db = supabaseAdmin();
  const { data: court } = await db
    .from("courts")
    .select("display_name")
    .eq("event_id", eventId)
    .eq("court_number", courtNumber)
    .maybeSingle();

  return {
    displayName: court?.display_name ?? null
  };
}
