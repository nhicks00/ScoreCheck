import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getEnv } from "@/lib/env";
import {
  checkProgramToken,
  programBuildVersion,
  programCommentaryBufferMs,
  programCommentarySceneUrl
} from "@/lib/program";
import { supabaseAdmin } from "@/lib/supabase";
import { courtStreamPath, courtStreamSources, videoConfigured } from "@/lib/video";
import { ProgramClient } from "./ProgramClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Program | ScoreCheck",
  robots: { index: false, follow: false }
};

/**
 * The broadcast scene for one court (docs/PRODUCTION_PLATFORM_PLAN.md §3.1):
 * a headless-Chrome LiveKit egress opens this URL and pushes the rendered
 * canvas to YouTube. Token-gated with a plain 404 for anything else — the
 * consumer is a machine, so there are no cookies and no login redirect.
 *
 * Query params: ?token= (required), ?cbuf=<0..4000> commentary audio delay,
 * ?scene=0 disables commentary audio, ?debug=1 shows the diagnostics strip.
 */
export default async function ProgramCourtPage({ params, searchParams }: {
  params: Promise<{ courtNumber: string }>;
  searchParams: Promise<{ token?: string; cbuf?: string; scene?: string; debug?: string }>;
}) {
  const { courtNumber: courtParam } = await params;
  const { token, cbuf, scene, debug } = await searchParams;

  // Wrong/missing token — or PROGRAM_PAGE_TOKEN unset — is a plain 404.
  const tokenValue = typeof token === "string" ? token : null;
  if (!tokenValue || !checkProgramToken(tokenValue)) notFound();

  const env = getEnv();
  const courtNumber = Number(courtParam);
  if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > env.courtCount) notFound();

  const court = await loadCourt(courtNumber);
  const sources = videoConfigured()
    ? courtStreamSources(courtStreamPath(courtNumber, court.streamPath))
    : { whepUrl: null, hlsUrl: null };

  const commentaryUrl = scene === "0"
    ? null
    : programCommentarySceneUrl(courtNumber, programCommentaryBufferMs(cbuf));

  return (
    <ProgramClient
      courtNumber={courtNumber}
      token={tokenValue}
      sources={sources}
      commentaryUrl={commentaryUrl}
      debug={debug === "1"}
      buildVersion={programBuildVersion()}
    />
  );
}

async function loadCourt(courtNumber: number): Promise<{ streamPath: string | null }> {
  const env = getEnv();
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return { streamPath: null };

  const db = supabaseAdmin();
  const { data: event } = await db
    .from("events")
    .select("id")
    .eq("slug", env.defaultEventSlug)
    .maybeSingle();
  if (!event) return { streamPath: null };

  const { data: court } = await db
    .from("courts")
    .select("stream_path")
    .eq("event_id", event.id)
    .eq("court_number", courtNumber)
    .maybeSingle();

  return { streamPath: court?.stream_path ?? null };
}
