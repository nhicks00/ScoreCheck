import type { IncidentSnapshot } from "./contracts.js";

export type OperatorNotificationCopy = {
  title: string;
  problem: string;
  action: string;
  recoveryTitle: string;
  recovery: string;
};

export function operatorNotificationCopy(incident: IncidentSnapshot): OperatorNotificationCopy {
  const camera = incident.courtNumber == null ? null : `Camera ${incident.courtNumber}`;
  const subject = camera ?? "ScoreCheck";
  const base = {
    title: `${subject} needs attention`,
    recoveryTitle: `${subject} is back to normal`
  };
  const issue = incident.issueCode;

  if (incident.evidence.expectationSource === "fault_gate" || incident.summary.startsWith("[INTENTIONAL FAULT GATE]")) {
    return {
      title: `TEST: ${subject} feed stopped`,
      problem: `This is the planned ${subject} disconnect test.`,
      action: `Leave ${subject} off until ScoreCheck tells you to restart it.`,
      recoveryTitle: `TEST: ${subject} feed is back`,
      recovery: `${subject} is sending video again. The planned test is complete.`
    };
  }

  if (matches(issue, ["FULL_BITRATE_VISUAL_FREEZE", "VISUAL_FREEZE_SUSPECTED"])) {
    return { ...base, problem: `${camera ?? "A camera"}'s picture is frozen.`, action: `Check ${camera ?? "the camera"}. If its screen is also frozen, restart that camera's stream.`, recovery: `${camera ?? "The camera"}'s picture is moving again. No action is needed.` };
  }
  if (issue === "CAMERA_CONTENT_BLACK") {
    return { ...base, problem: `${camera ?? "A camera"}'s picture is black or covered.`, action: `Check ${camera ?? "the camera"}'s lens and the picture shown on the camera.`, recovery: `${camera ?? "The camera"}'s picture is visible again. No action is needed.` };
  }
  if (matches(issue, ["CAMERA_AUDIO_TRACK_MISSING", "CAMERA_AUDIO_SILENT"])) {
    return { ...base, problem: `${camera ?? "A camera"} is sending video without usable sound.`, action: `Check ${camera ?? "the camera"}'s microphone, mute setting, and audio input.`, recovery: `${camera ?? "The camera"}'s sound is back. No action is needed.` };
  }
  if (issue === "CAMERA_AUDIO_CLIPPING") {
    return { ...base, problem: `${camera ?? "A camera"}'s sound is distorted.`, action: `Lower ${camera ?? "the camera"}'s audio input level and listen again.`, recovery: `${camera ?? "The camera"}'s sound level is normal again. No action is needed.` };
  }
  if (incident.stage === "RAW_INGEST" || matches(issue, ["REQUIRED_RAW_PATH_MISSING", "REQUIRED_PATH_MISSING", "RAW_BITRATE_LOW", "NO_PATH_OBSERVATION", "PATH_NOT_READY_EXPECTATION_UNKNOWN", "MEDIA_FRAME_ERRORS"])) {
    return { ...base, problem: `${camera ?? "A camera"} stopped sending usable video.`, action: `Check that ${camera ?? "the camera"} is powered on, connected to the internet, and still streaming.`, recovery: `${camera ?? "The camera"} is sending video again. No action is needed.` };
  }
  if (incident.stage === "COMMENTARY") {
    const network = issue.includes("PACKET_LOSS") || issue.includes("JITTER");
    const sync = issue.includes("SYNC");
    return {
      ...base,
      problem: network ? `The commentator connection for ${camera ?? "a camera"} is unstable.` : sync ? `The commentator sound for ${camera ?? "a camera"} is out of sync.` : `Commentator sound is missing for ${camera ?? "a camera"}.`,
      action: network ? "Ask the commentator to use a stronger internet connection, then reconnect." : "Ask the commentator to check mute and microphone settings, then reconnect to the commentary page.",
      recovery: `Commentator sound for ${camera ?? "the camera"} is working normally again. No action is needed.`
    };
  }
  if (incident.stage === "SCORE_SOURCE" || incident.stage === "SCORE_RENDER" || issue.includes("SCORE") || issue.includes("MATCH_MISMATCH") || issue.includes("67_67")) {
    return { ...base, problem: `The scoreboard for ${camera ?? "a camera"} does not match live scoring.`, action: `Open ${camera ?? "the camera"} in ScoreCheck and verify the selected match and score before changing anything.`, recovery: `The scoreboard for ${camera ?? "the camera"} matches live scoring again. No action is needed.` };
  }
  if (incident.stage === "YOUTUBE" || issue.startsWith("YOUTUBE_")) {
    return { ...base, problem: `YouTube reports a problem with ${camera ?? "a ScoreCheck"} broadcast.`, action: `Open YouTube Live Control Room and check that the broadcast is receiving video and sound.`, recovery: `YouTube reports that ${camera ?? "the broadcast"} is healthy again. No action is needed.` };
  }
  if (incident.stage === "EGRESS" || issue.startsWith("EGRESS_")) {
    const capacity = issue.includes("CAPACITY");
    return {
      ...base,
      problem: capacity ? "ScoreCheck does not have room to start another broadcast." : `${camera ?? "A camera"}'s broadcast output stopped.`,
      action: capacity ? "Do not start another broadcast until an unused output is stopped or more capacity is available." : `Leave ${camera ?? "the camera"} streaming, then restart its broadcast output in ScoreCheck.`,
      recovery: capacity ? "Broadcast capacity is available again. No action is needed." : `${camera ?? "The camera"}'s broadcast output is working again. No action is needed.`
    };
  }
  if (incident.stage === "PREVIEW" || incident.stage === "PROGRAM_PATH" || incident.stage === "PROGRAM_BROWSER") {
    return { ...base, problem: `${camera ?? "A camera"}'s broadcast picture is stuttering or frozen.`, action: `Leave ${camera ?? "the camera"} streaming. Open it in ScoreCheck and restart only its broadcast output.`, recovery: `${camera ?? "The camera"}'s broadcast picture is moving normally again. No action is needed.` };
  }
  if (incident.stage === "VENUE") {
    return { ...base, problem: "The venue internet connection is unstable.", action: "Check the venue router and internet connection before changing any camera settings.", recovery: "The venue internet connection is stable again. No action is needed." };
  }
  if (issue.includes("MEMORY_LOW")) {
    return { ...base, problem: "A ScoreCheck server is running low on memory.", action: "Keep the dashboard open and contact the technical operator before starting another broadcast.", recovery: "The ScoreCheck server has enough memory again. No action is needed." };
  }
  if (issue.includes("DISK_LOW")) {
    return { ...base, problem: "A ScoreCheck server is running low on storage.", action: "Keep the dashboard open and contact the technical operator before recording more video.", recovery: "The ScoreCheck server has enough storage again. No action is needed." };
  }
  if (incident.stage === "NOTIFICATION" || issue.includes("NOTIFICATION_PROVIDER")) {
    return { ...base, problem: "Phone alerts may not be delivered.", action: "Keep the ScoreCheck monitor open until phone alerts are working again.", recovery: "Phone alerts are working again. No action is needed." };
  }
  if (incident.stage === "MONITORING" || issue.includes("DEAD_MAN")) {
    return { ...base, problem: "ScoreCheck may not be able to detect or report new problems.", action: "Keep the dashboard open and contact the technical operator now.", recovery: "ScoreCheck monitoring is working again. No action is needed." };
  }
  if (incident.stage === "HOST" || incident.stage === "CONTROL") {
    return { ...base, problem: "A ScoreCheck service stopped working.", action: "Keep camera streams running and contact the technical operator before restarting anything.", recovery: "The ScoreCheck service is working again. No action is needed." };
  }

  return { ...base, problem: `${subject} has a problem that needs review.`, action: "Open the ScoreCheck monitor and follow the first red item.", recovery: `${subject} is working normally again. No action is needed.` };
}

function matches(issue: string, values: string[]): boolean {
  return values.some((value) => issue === value || issue.includes(value));
}
