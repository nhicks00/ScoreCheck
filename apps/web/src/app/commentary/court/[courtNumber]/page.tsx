import { redirect } from "next/navigation";
import { vdoGuestUrl, vdoRoomName } from "@/lib/commentary";
import { isCommentaryRequest } from "@/lib/commentaryAuth";
import { getEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase";
import { courtStreamPath, courtStreamSources, videoConfigured } from "@/lib/video";
import { CommentaryCourtClient } from "./CommentaryCourtClient";

export const dynamic = "force-dynamic";

export default async function CommentaryCourtPage({ params }: { params: Promise<{ courtNumber: string }> }) {
  if (!(await isCommentaryRequest())) redirect("/commentary");

  const env = getEnv();
  const { courtNumber: courtParam } = await params;
  const courtNumber = Number(courtParam);
  if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > env.courtCount) redirect("/commentary");

  const court = await loadCourt(courtNumber);
  const sources = videoConfigured()
    ? courtStreamSources(courtStreamPath(courtNumber, court.streamPath))
    : { whepUrl: null, hlsUrl: null };

  return (
    <CommentaryCourtClient
      courtNumber={courtNumber}
      courtName={court.displayName ?? `Court ${courtNumber}`}
      eventSlug={env.defaultEventSlug}
      eventName={env.eventName}
      sources={sources}
      roomName={vdoRoomName(courtNumber)}
      guestUrl={vdoGuestUrl(courtNumber)}
    />
  );
}

async function loadCourt(courtNumber: number): Promise<{ streamPath: string | null; displayName: string | null }> {
  const env = getEnv();
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return { streamPath: null, displayName: null };

  const db = supabaseAdmin();
  const { data: event } = await db
    .from("events")
    .select("id")
    .eq("slug", env.defaultEventSlug)
    .maybeSingle();
  if (!event) return { streamPath: null, displayName: null };

  const { data: court } = await db
    .from("courts")
    .select("stream_path, display_name")
    .eq("event_id", event.id)
    .eq("court_number", courtNumber)
    .maybeSingle();

  return {
    streamPath: court?.stream_path ?? null,
    displayName: court?.display_name ?? null
  };
}
