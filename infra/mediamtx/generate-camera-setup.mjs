import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputPath = process.env.CAMERA_SETUP_OUTPUT
  ? path.resolve(process.env.CAMERA_SETUP_OUTPUT)
  : path.join(directory, ".generated", "eight-camera-setup.txt");
const host = process.env.MEDIAMTX_PUBLIC_HOST?.trim() || "preview.beachvolleyballmedia.com";
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
  "Router PEP: On for the two RTMP cameras, when available",
  "Reconnect: On",
  "H.264 / CBR / AAC 48 kHz 128 kbps / one-second keyframe interval",
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
  if (court <= 2) {
    const key = `court${court}_raw?user=${user}&pass=${pass}`;
    lines.push(`Camera: Mevo Core ${court}`);
    lines.push("Protocol: RTMP");
    lines.push("Resolution / frame rate: 1920x1080 at 60 fps");
    lines.push("Video bitrate: 6000 kbps CBR");
    lines.push(`Server URL: rtmp://${host}:1935`);
    lines.push(`Stream key: ${key}`);
    lines.push(`Complete URL: rtmp://${host}:1935/${key}`);
  } else {
    const streamId = `publish:court${court}_raw:${user}:${pass}`;
    const standardStreamId = `#!::m=publish,r=court${court}_raw,u=${user},s=${pass}`;
    lines.push("Protocol: SRT");
    lines.push("Connection role: Caller");
    lines.push("Transmission type: Live");
    lines.push("Resolution / frame rate: 1920x1080 at 30 fps");
    lines.push("Video bitrate: 4500-5000 kbps CBR");
    lines.push("Input bandwidth: Match the configured stream bitrate");
    lines.push("Recovery overhead: 25%");
    lines.push("Latency: 2500 ms");
    lines.push("Packet size / payload size: 1316 bytes");
    lines.push("TSBPD / timestamp delivery: On");
    lines.push("Too-late packet drop: On");
    lines.push("NAK / loss reporting: On");
    lines.push("Reconnect: On with a short retry interval");
    lines.push(`Server URL: srt://${host}:8890`);
    lines.push(`Stream ID / stream key: ${streamId}`);
    lines.push(`Complete URL: srt://${host}:8890?streamid=${streamId}&pkt_size=1316`);
    lines.push(`Standard Stream ID alternative: ${standardStreamId}`);
  }
  lines.push("");
}

lines.push("SRT NOTES");
lines.push("Use the custom Stream ID first. Use the standard alternative only if the camera rejects it.");
lines.push("Set latency in the camera UI to 2500 ms; do not leave a prior 350-400 ms value.");
lines.push("Encryption/passphrase: Off for this test; the Speedify tunnel provides the encrypted transport.");
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
