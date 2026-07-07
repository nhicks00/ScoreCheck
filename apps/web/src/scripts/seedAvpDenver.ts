import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../lib/env";
import { ensureAvpDenverSeeded } from "../lib/eventConfig";
import { courtStreamPath } from "../lib/video";
import { loadLocalEnv } from "./envLoader";

async function main() {
  loadLocalEnv();
  const env = getEnv();
  const generatedYoutube = readGeneratedYoutube();
  const courtStreamPaths: Record<number, string> = {};
  const courtYoutube: Record<number, { displayName?: string; videoId?: string; liveChatId?: string }> = {};
  for (let court = 1; court <= env.courtCount; court += 1) {
    courtStreamPaths[court] = courtStreamPath(court);
    const youtube = generatedYoutube[court];
    courtYoutube[court] = {
      displayName: youtube?.displayName,
      videoId: youtube?.youtubeVideoId,
      liveChatId: youtube?.youtubeLiveChatId
    };
  }
  const event = await ensureAvpDenverSeeded({ courtStreamPaths, courtYoutube });
  console.log(`Seeded ${event.name} (${event.slug ?? event.id})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

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
