import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getEnv } from "@/lib/env";
import { getActiveEvent } from "@/lib/eventConfig";
import { createCommentaryConnection } from "@/lib/commentary";
import {
  checkProgramToken,
  programBuildVersion,
  programCommentaryBufferMs
} from "@/lib/program";
import { supabaseAdmin } from "@/lib/supabase";
import { courtProgramStreamPath, courtStreamSources, videoConfigured } from "@/lib/video";
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
    ? courtStreamSources(courtProgramStreamPath(courtNumber, court.programStreamPath))
    : { whepUrl: null, hlsUrl: null };

  const commentary = scene === "0"
    ? null
    : await createCommentaryConnection({ courtNumber, displayName: "Program mixer", role: "program" }).catch(() => null);
  const commentaryDelayOverride = programCommentaryBufferMs(cbuf);

  return (
    <ProgramClient
      courtNumber={courtNumber}
      token={tokenValue}
      sources={sources}
      commentary={commentary}
      cameraGainDb={court.cameraGainDb}
      commentaryGainDb={court.commentaryGainDb}
      commentaryDelayMs={commentaryDelayOverride ?? court.commentaryDelayMs}
      debug={debug === "1"}
      buildVersion={programBuildVersion()}
    />
  );
}

type ProgramCourtConfig = {
  programStreamPath: string | null;
  cameraGainDb: number;
  commentaryGainDb: number;
  commentaryDelayMs: number;
};

const EMPTY_PROGRAM_COURT: ProgramCourtConfig = {
  programStreamPath: null,
  cameraGainDb: 0,
  commentaryGainDb: 0,
  commentaryDelayMs: 0
};

async function loadCourt(courtNumber: number): Promise<ProgramCourtConfig> {
  const env = getEnv();
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return EMPTY_PROGRAM_COURT;

  const db = supabaseAdmin();
  const event = await getActiveEvent(db);
  if (!event) return EMPTY_PROGRAM_COURT;

  const { data: court } = await db
    .from("courts")
    .select("program_stream_path,camera_audio_gain_db,commentary_gain_db,commentary_delay_ms")
    .eq("event_id", event.id)
    .eq("court_number", courtNumber)
    .maybeSingle();

  return {
    programStreamPath: court?.program_stream_path ?? null,
    cameraGainDb: finiteNumber(court?.camera_audio_gain_db),
    commentaryGainDb: finiteNumber(court?.commentary_gain_db),
    commentaryDelayMs: Math.max(0, finiteNumber(court?.commentary_delay_ms))
  };
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
