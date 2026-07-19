import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { getEnv, missingEnvKeys } from "@/lib/env";
import { buildProgramMonitorPath, controllerConfiguredFromEnv } from "@/lib/opsConsole";
import { programPageToken } from "@/lib/program";
import { loadProductionSnapshot } from "@/lib/productionStatus";
import { courtStreamSources, videoConfigured } from "@/lib/video";
import { AdminTopbar } from "@/components/AdminTopbar";
import { SetupNotice } from "@/components/SetupNotice";
import { ProductionConsoleClient, type CourtClientConfig } from "./ProductionConsoleClient";

export const dynamic = "force-dynamic";

/**
 * Production ops console (docs/PRODUCTION_PLATFORM_PLAN.md §3.5): per-court
 * program health, muted preview monitors, broadcast start/stop via the
 * production controller, YouTube stream keys, and the sync runbook. This
 * server component assembles everything secret-adjacent — program-page links
 * only exist in the payload when PROGRAM_PAGE_TOKEN is set, YouTube keys are
 * masked before they leave the server, controller credentials never leave at
 * all (the client talks to our proxy routes).
 */
export default async function ProductionConsolePage() {
  if (!(await isAdminRequest())) {
    redirect(`/admin/login?next=${encodeURIComponent("/admin/production")}`);
  }

  const missing = missingEnvKeys();
  if (missing.length) {
    return (
      <main className="shell production-shell">
        <div className="container stack">
          <AdminTopbar />
          <SetupNotice />
        </div>
      </main>
    );
  }

  const env = getEnv();
  const snapshot = await loadProductionSnapshot();
  const token = programPageToken();
  const hasVideo = videoConfigured();

  const courtConfigs: CourtClientConfig[] = snapshot.courts.map((court) => ({
    courtNumber: court.courtNumber,
    // Pre-resolved playback sources for the lazy monitor players (same shape
    // StreamPlayer's `sources` prop takes; read creds ride along like they do
    // for scorer/commentary players).
    sources: hasVideo ? courtStreamSources(court.previewStreamPath) : null,
    // Token-gated program-page link: null unless PROGRAM_PAGE_TOKEN is set,
    // so the token never reaches the client as an empty/implied value.
    programUrl: buildProgramMonitorPath(court.courtNumber, token)
  }));

  return (
    <ProductionConsoleClient
      initialSnapshot={snapshot}
      courtConfigs={courtConfigs}
      controllerConfigured={controllerConfiguredFromEnv()}
      videoConfigured={hasVideo}
      courtCount={env.courtCount}
    />
  );
}
