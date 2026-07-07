import { getEnv } from "../lib/env";
import { ensureAvpDenverSeeded } from "../lib/eventConfig";
import { courtStreamPath } from "../lib/video";
import { loadLocalEnv } from "./envLoader";

async function main() {
  loadLocalEnv();
  const env = getEnv();
  const courtStreamPaths: Record<number, string> = {};
  for (let court = 1; court <= env.courtCount; court += 1) {
    courtStreamPaths[court] = courtStreamPath(court);
  }
  const event = await ensureAvpDenverSeeded({ courtStreamPaths });
  console.log(`Seeded ${event.name} (${event.slug ?? event.id})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
