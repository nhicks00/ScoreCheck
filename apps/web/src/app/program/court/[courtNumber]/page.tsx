import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getEnv } from "@/lib/env";
import { getActiveEvent } from "@/lib/eventConfig";
import { createCommentaryConnection } from "@/lib/commentary";
import {
  PROGRAM_SESSION_COOKIE,
  programBuildVersion,
  programCommentaryBufferMs,
  verifyProgramSession
} from "@/lib/program";
import { createProgramMonitoringConnection } from "@/lib/programMonitoring";
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
 * canvas to YouTube. A fragment bootstrap exchanges the event-scoped machine
 * token for a court/build/deployment-scoped HttpOnly cookie. Invalid or stale
 * renderer bindings receive a plain 404 with no login redirect.
 *
 * Query params: ?build= and ?deployment= (required immutable renderer binding),
 * ?cbuf=<0..10000> commentary audio delay, ?scene=0 disables commentary audio,
 * ?debug=1 shows the diagnostics strip.
 */
export default async function ProgramCourtPage({ params, searchParams }: {
  params: Promise<{ courtNumber: string }>;
  searchParams: Promise<{ build?: string; deployment?: string; cbuf?: string; scene?: string; debug?: string }>;
}) {
  const { courtNumber: courtParam } = await params;
  const { build, deployment, cbuf, scene, debug } = await searchParams;

  const env = getEnv();
  const courtNumber = Number(courtParam);
  if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > env.courtCount) notFound();
  const cookieStore = await cookies();
  if (!verifyProgramSession({
    session: cookieStore.get(PROGRAM_SESSION_COOKIE)?.value,
    court: courtNumber,
    expectedBuild: typeof build === "string" ? build : null,
    expectedDeployment: typeof deployment === "string" ? deployment : null
  })) notFound();

  const court = await loadCourt(courtNumber);
  const sources = videoConfigured()
    ? courtStreamSources(courtProgramStreamPath(courtNumber, court.programStreamPath))
    : { whepUrl: null, hlsUrl: null };

  const commentary = scene === "0"
    ? null
    : await createCommentaryConnection({ courtNumber, displayName: "Program mixer", role: "program" }).catch(() => null);
  const commentaryDelayOverride = programCommentaryBufferMs(cbuf);
  const monitoring = createProgramMonitoringConnection(courtNumber);

  return (
    <ProgramClient
      courtNumber={courtNumber}
      sources={sources}
      commentary={commentary}
      cameraGainDb={court.cameraGainDb}
      commentaryGainDb={court.commentaryGainDb}
      commentaryDelayMs={commentaryDelayOverride ?? court.commentaryDelayMs}
      debug={debug === "1"}
      buildVersion={programBuildVersion()}
      configurationVersion={court.configurationVersion}
      monitoring={monitoring}
    />
  );
}

type ProgramCourtConfig = {
  programStreamPath: string | null;
  cameraGainDb: number;
  commentaryGainDb: number;
  commentaryDelayMs: number;
  configurationVersion: string;
};

const EMPTY_PROGRAM_COURT: ProgramCourtConfig = {
  programStreamPath: null,
  cameraGainDb: 0,
  commentaryGainDb: 0,
  commentaryDelayMs: 0,
  configurationVersion: "unknown"
};

async function loadCourt(courtNumber: number): Promise<ProgramCourtConfig> {
  const env = getEnv();
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return EMPTY_PROGRAM_COURT;

  const db = supabaseAdmin();
  const event = await getActiveEvent(db);
  if (!event) return EMPTY_PROGRAM_COURT;

  const { data: court } = await db
    .from("courts")
    .select("id,updated_at,program_stream_path,camera_audio_gain_db,commentary_gain_db,commentary_delay_ms")
    .eq("event_id", event.id)
    .eq("court_number", courtNumber)
    .maybeSingle();

  return {
    programStreamPath: court?.program_stream_path ?? null,
    cameraGainDb: finiteNumber(court?.camera_audio_gain_db),
    commentaryGainDb: finiteNumber(court?.commentary_gain_db),
    commentaryDelayMs: Math.max(0, finiteNumber(court?.commentary_delay_ms)),
    configurationVersion: configurationVersion(court?.id, court?.updated_at)
  };
}

function configurationVersion(courtId: unknown, updatedAt: unknown): string {
  const id = typeof courtId === "string" ? courtId : "court";
  const timestamp = Date.parse(typeof updatedAt === "string" ? updatedAt : "");
  return `${id}:${Number.isFinite(timestamp) ? timestamp : 0}`.slice(0, 64);
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
