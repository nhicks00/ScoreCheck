import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputPath = process.env.CAMERA_SETUP_OUTPUT
  ? path.resolve(process.env.CAMERA_SETUP_OUTPUT)
  : path.join(directory, ".generated", "eight-camera-setup.txt");
const host = process.env.MEDIAMTX_PUBLIC_HOST?.trim() || "preview.beachvolleyballmedia.com";
const makiSrtHosts = new Map([
  [6, "192.168.8.170"],
  [7, "192.168.8.238"],
  [8, "192.168.8.206"]
]);
const makiSrtPorts = new Map([
  [6, 1026],
  [7, 1027],
  [8, 1025]
]);
const lines = [
  "SCORECHECK EIGHT-CAMERA TEST - COPY/PASTE SETTINGS",
  "=================================================",
  "",
  "Do not share this file. It contains live camera publishing credentials.",
  "Final ScoreCheck program output remains 1280x720 at 30 fps for this test.",
  "Mevo 1080p60 is an intentional ingest stress input, not the production output format.",
  "",
  "GLOBAL NETWORK SETTINGS",
  "Speedify mode: Speed",
  "Enhance Streaming: On",
  "Speedify transport: UDP (not Auto)",
  "Router PEP: On for all RTMP cameras, when available",
  "Reconnect: On",
  "CBR / AAC 48 kHz 128 kbps / one-second keyframe interval",
  "Local camera recording: On",
  "Minimum sustained bonded upload: 75 Mbps; preferred: 85-100 Mbps",
  "Keep base camera bitrate at or below 60% of worst sustained bonded upload",
  "Camera Wi-Fi: two wired-backhaul 5 GHz APs, four cameras each",
  "Wi-Fi channels: fixed non-DFS, 20 MHz initially; no auto channel changes",
  ""
];

for (let court = 1; court <= 8; court += 1) {
  const user = required(`MEDIAMTX_COURT_${court}_PUBLISH_USER`);
  const pass = required(`MEDIAMTX_COURT_${court}_PUBLISH_PASS`);
  lines.push(`STREAM ${court} / COURT ${court}`);
  lines.push("----------------------------------------");
  const isMevo = court <= 2;
  if (isMevo) {
    const key = `court${court}_raw?user=${user}&pass=${pass}`;
    lines.push(`Camera: Mevo Core ${court}`);
    lines.push("Protocol: RTMP");
    lines.push("Video codec: H.264");
    lines.push("Resolution / frame rate: 1920x1080 at 60 fps");
    lines.push("Video bitrate: 6000 kbps CBR");
    lines.push(`Server URL: rtmp://${host}:1935`);
    lines.push(`Stream key: ${key}`);
    lines.push(`Complete URL: rtmp://${host}:1935/${key}`);
  } else {
    const isAvkans = court <= 5;
    const streamId = `publish:court${court}_raw:${user}:${pass}`;
    const standardStreamId = `#!::m=publish,r=court${court}_raw,u=${user},s=${pass}`;
    lines.push(`Camera: ${isAvkans ? `AVKANS Go ${court - 2}` : `MAKI Live ${court - 5}`}`);
    lines.push("Protocol: SRT");
    lines.push(`Connection role: ${isAvkans ? "Caller" : "Listener (ingest VPS connects as Caller)"}`);
    lines.push("Transmission type: Live");
    lines.push(`Video codec: ${isAvkans ? "HEVC / H.265" : "H.264"}`);
    lines.push("Resolution / frame rate: 1920x1080 at 30 fps");
    lines.push("Video bitrate: 3000 kbps CBR");
    lines.push("Input bandwidth: 3000 kbps");
    lines.push("Recovery overhead: 25%");
    lines.push(`Latency: ${isAvkans ? "2500 ms" : "500 ms (camera firmware maximum)"}`);
    lines.push("Packet size / payload size: 1316 bytes");
    lines.push("TSBPD / timestamp delivery: On");
    lines.push("Too-late packet drop: On");
    lines.push("NAK / loss reporting: On");
    lines.push("Reconnect: On with a short retry interval");
    if (isAvkans) {
      lines.push(`Server URL: srt://${host}:8890`);
      lines.push(`Stream ID / stream key: ${streamId}`);
      lines.push(`Complete URL: srt://${host}:8890?streamid=${streamId}&pkt_size=1316`);
      lines.push(`Standard Stream ID alternative: ${standardStreamId}`);
    } else {
      const localHost = makiSrtHosts.get(court);
      const listenerPort = makiSrtPorts.get(court);
      lines.push(`Camera listener port: ${listenerPort}`);
      lines.push(`Camera SRT address: srt://${localHost}:${listenerPort}`);
      lines.push(`MediaMTX raw source: srt://${localHost}:${listenerPort}?mode=caller&latency=2500000`);
      lines.push(`MediaMTX path: court${court}_raw`);
      lines.push("Stream ID / stream key: None (private listener pulled through WireGuard)");
    }
  }
  lines.push("");
}

lines.push("SRT NOTES");
lines.push("AVKANS cameras publish directly in Caller mode using their custom Stream ID.");
lines.push("MAKI 6-8 stay in Listener mode; MediaMTX reaches them through WireGuard and owns the Caller/reconnect lifecycle.");
lines.push("Use the custom Stream ID first for AVKANS. MAKI listeners do not use stream keys.");
lines.push("Set AVKANS latency to 2500 ms. MAKI cameras cap latency at 500 ms; MediaMTX applies 2500 ms receive latency.");
lines.push("Encryption/passphrase: Off for this test; the Speedify tunnel provides the encrypted transport.");
lines.push("Do not paste a public server URL or stream key into a MAKI listener screen.");
lines.push("");
lines.push("Do not start changing fields after a camera connects. Report which stream is online and leave it running.");

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
await chmod(outputPath, 0o600);
console.log(`Wrote protected camera setup document to ${outputPath}.`);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
