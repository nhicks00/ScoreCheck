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
  "Final ScoreCheck program output remains 1920x1080 at the manifest-selected 30 or 60 fps.",
  "Cameras 1-2 use HEVC through their isolated browser normalizers; Cameras 3-8 use direct browser-safe H.264.",
  "",
  "GLOBAL NETWORK SETTINGS",
  "Speedify mode: Speed",
  "Enhance Streaming: On",
  "Speedify transport: UDP (not Auto)",
  "Router PEP: On for all RTMP cameras, when available",
  "Speedify default route: Off; policy-route only MediaMTX RTMP/SRT ingest traffic",
  "Apply Speedify routing before cameras start; never migrate all active publishers together",
  "Reconnect: On",
  "CBR / AAC 48 kHz 128 kbps / one-second keyframe interval",
  "Local camera recording: On",
  "Minimum sustained bonded upload is enforced by the active venue profile before coverage.",
  "Keep base camera bitrate at or below 60% of worst sustained bonded upload",
  "Camera Wi-Fi: two wired-backhaul 5 GHz APs, four cameras each",
  "Wi-Fi channels: fixed non-DFS, 20 MHz initially; no auto channel changes",
  ""
];

for (let court = 1; court <= 8; court += 1) {
  const user = required(`MEDIAMTX_COURT_${court}_PUBLISH_USER`);
  const pass = required(`MEDIAMTX_COURT_${court}_PUBLISH_PASS`);
  const streamId = `publish:court${court}_raw:${user}:${pass}`;
  const standardStreamId = `#!::m=publish,r=court${court}_raw,u=${user},s=${pass}`;
  lines.push(`STREAM ${court} / COURT ${court}`);
  lines.push("----------------------------------------");
  const isMevo = court <= 2;
  if (isMevo) {
    lines.push(`Camera: Mevo Core ${court}`);
    lines.push("Protocol: SRT");
    lines.push("Connection role: Caller");
    lines.push("Video codec: HEVC / H.265");
    lines.push("Resolution / frame rate: 1920x1080 at the event manifest's selected 30 or 60 fps");
    lines.push("Video bitrate: use the active event profile cap");
  } else {
    lines.push(`Camera: AVKANS Go ${court - 2}`);
    lines.push("Protocol: SRT");
    lines.push("Connection role: Caller");
    lines.push("Transmission type: Live");
    lines.push("Video codec: H.264 High, yuv420p, progressive, no B-frames");
    lines.push("Resolution / frame rate: 1920x1080 at 30 fps");
    lines.push("Video bitrate: 3000 kbps CBR");
    lines.push("Input bandwidth: 3000 kbps");
    lines.push("Recovery overhead: 25%");
    lines.push("Camera latency: 2500 ms (ingest negotiates an 8000 ms receiver floor)");
    lines.push("Packet size / payload size: 1316 bytes");
    lines.push("TSBPD / timestamp delivery: On");
    lines.push("Too-late packet drop: On");
    lines.push("NAK / loss reporting: On");
    lines.push("Reconnect: On with a short retry interval");
  }
  lines.push(`Server URL: srt://${host}:8890`);
  lines.push(`Stream ID / stream key: ${streamId}`);
  lines.push(`Complete URL: srt://${host}:8890?streamid=${streamId}&pkt_size=1316`);
  lines.push(`Standard Stream ID alternative: ${standardStreamId}`);
  lines.push("");
}

lines.push("SRT NOTES");
lines.push("All cameras publish directly in Caller mode using their permanent Camera 1-8 Stream ID.");
lines.push("Keep the camera at 2500 ms SRT latency; ingest negotiates an 8000 ms receiver floor for retransmission headroom.");
lines.push("Use the event manifest's encryption/passphrase assignment; never downgrade it implicitly.");
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
