import fs from "node:fs";
import path from "node:path";
import { courtIvsEnv, getEnv } from "../lib/env";
import { ensureAvpDenverSeeded } from "../lib/eventConfig";
import { loadLocalEnv } from "./envLoader";

async function main() {
  loadLocalEnv();
  const env = getEnv();
  const generatedIvs = readGeneratedIvs();
  const generatedYoutube = readGeneratedYoutube();
  const courtIvs: Record<number, { channelArn?: string; playbackUrl?: string }> = {};
  const courtYoutube: Record<number, { displayName?: string; videoId?: string; liveChatId?: string }> = {};
  for (let court = 1; court <= env.courtCount; court += 1) {
    const values = courtIvsEnv(court);
    const generated = generatedIvs[court];
    courtIvs[court] = {
      channelArn: values.channelArn || generated?.channelArn,
      playbackUrl: values.playbackUrl || generated?.playbackUrl
    };
    const youtube = generatedYoutube[court];
    courtYoutube[court] = {
      displayName: youtube?.displayName,
      videoId: youtube?.youtubeVideoId,
      liveChatId: youtube?.youtubeLiveChatId
    };
  }
  const event = await ensureAvpDenverSeeded({ courtIvs, courtYoutube });
  console.log(`Seeded ${event.name} (${event.slug ?? event.id})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

function readGeneratedIvs() {
  const file = path.join(process.cwd(), ".local", "aws-ivs.generated.json");
  const contents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const parsed = contents ? JSON.parse(contents) as { channels?: Array<{ court: number; channelArn?: string; playbackUrl?: string }> } : {};
  return Object.fromEntries((parsed.channels ?? []).map((channel) => [channel.court, channel]));
}

function readGeneratedYoutube() {
  const file = path.join(process.cwd(), ".local", "youtube-denver.generated.json");
  const contents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const parsed = contents
    ? JSON.parse(contents) as {
      courts?: Array<{
        courtNumber: number;
        displayName?: string;
        youtubeVideoId?: string;
        youtubeLiveChatId?: string;
      }>;
    }
    : {};
  return Object.fromEntries((parsed.courts ?? []).map((court) => [court.courtNumber, court]));
}
