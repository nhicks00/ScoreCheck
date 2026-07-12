import { loadLocalEnv } from "../envLoader";
import { getActiveEvent } from "../../lib/eventConfig";
import { supabaseAdmin } from "../../lib/supabase";
import { courtPreviewStreamPath, videoConfigured } from "../../lib/video";

loadLocalEnv();

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

async function main() {
  const event = await getActiveEvent();
  if (!event) throw new Error("No active event found");
  const { data: courts, error } = await supabaseAdmin()
    .from("courts")
    .select("id,court_number,current_match_id,preview_stream_path")
    .eq("event_id", event.id)
    .order("court_number", { ascending: true });
  if (error) throw error;
  console.log(JSON.stringify({
    event: { id: event.id, slug: event.slug, name: event.name },
    videoConfigured: videoConfigured(),
    courts: courts?.map((court) => ({
      courtNumber: court.court_number,
      hasMatch: Boolean(court.current_match_id),
      previewStreamPath: courtPreviewStreamPath(court.court_number, court.preview_stream_path)
    }))
  }, null, 2));
}
