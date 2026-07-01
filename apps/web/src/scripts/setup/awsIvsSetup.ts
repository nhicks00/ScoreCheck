import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./redact";
import { loadLocalEnv } from "../envLoader";

loadLocalEnv();

const profile = process.env.AWS_PROFILE || "scorecheck-setup";
const region = process.env.AWS_REGION || "us-west-2";
const courtCount = Number(process.env.NEXT_PUBLIC_COURT_COUNT || 8);
const outputDir = path.join(process.cwd(), ".local");
fs.mkdirSync(outputDir, { recursive: true });

function aws(args: string[]) {
  const out = execFileSync("aws", [...args, "--profile", profile, "--region", region], { encoding: "utf8" });
  return JSON.parse(out || "{}");
}

const identity = aws(["sts", "get-caller-identity"]);
if (!String(identity.Arn ?? "").includes("user/scorecheck-setup-automation")) {
  throw new Error(`AWS profile must be scorecheck-setup-automation, got ${identity.Arn}`);
}

const existing = aws(["ivs", "list-channels"]).channels ?? [];
const channels = [];
for (let court = 1; court <= courtCount; court += 1) {
  const name = `bvm-avp-denver-court-${String(court).padStart(2, "0")}-preview`;
  let channel = existing.find((item: { name?: string }) => item.name === name);
  let streamKey = null;
  if (channel) {
    channel = aws(["ivs", "get-channel", "--arn", channel.arn]).channel;
  }
  if (!channel) {
    const created = aws([
      "ivs", "create-channel",
      "--name", name,
      "--type", process.env.AWS_IVS_CHANNEL_TYPE || "STANDARD",
      "--latency-mode", process.env.AWS_IVS_LATENCY_MODE || "LOW",
      "--authorized",
      "--no-insecure-ingest",
      "--container-format", process.env.AWS_IVS_CONTAINER_FORMAT || "TS",
      "--tags", `event=avp-denver,court=${court},project=scorecheck,purpose=scorer-preview`
    ]);
    channel = created.channel;
    streamKey = created.streamKey;
  }
  const keys = aws(["ivs", "list-stream-keys", "--channel-arn", channel.arn]).streamKeys ?? [];
  if (!streamKey && keys[0]?.arn) {
    streamKey = aws(["ivs", "get-stream-key", "--arn", keys[0].arn]).streamKey;
  }
  channels.push({
    court,
    channelArn: channel.arn,
    ingestEndpoint: channel.ingestEndpoint,
    playbackUrl: channel.playbackUrl,
    streamKeyArn: streamKey?.arn ?? keys[0]?.arn ?? null,
    streamKeyValue: streamKey?.value ?? null,
    rtmpsServerUrl: channel.ingestEndpoint ? `rtmps://${channel.ingestEndpoint}:443/app/` : null
  });
}

const generated = { region, channels };
fs.writeFileSync(path.join(outputDir, "aws-ivs.generated.json"), JSON.stringify(generated, null, 2));
fs.writeFileSync(path.join(outputDir, "aws-ivs.redacted.json"), JSON.stringify(redact(generated), null, 2));
console.log(`Wrote ${path.join(outputDir, "aws-ivs.generated.json")}`);
