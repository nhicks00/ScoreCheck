import { loadLocalEnv } from "../envLoader";
import { getActiveEvent } from "../../lib/eventConfig";
import { supabaseAdmin } from "../../lib/supabase";

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
    .select("id,court_number,current_match_id,ivs_channel_arn,ivs_playback_url,youtube_live_chat_id")
    .eq("event_id", event.id)
    .order("court_number", { ascending: true });
  if (error) throw error;
  console.log(JSON.stringify({
    event: { id: event.id, slug: event.slug, name: event.name },
    courts: courts?.map((court) => ({
      courtNumber: court.court_number,
      hasMatch: Boolean(court.current_match_id),
      hasIvsPlayback: Boolean(court.ivs_channel_arn && court.ivs_playback_url),
      hasYoutubeChat: Boolean(court.youtube_live_chat_id)
    }))
  }, null, 2));
}
