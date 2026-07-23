import { createHash } from "node:crypto";
import { chmod, readFile, stat } from "node:fs/promises";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const EVENT_SLUG = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._()+/:-]{0,119}$/u;
const ACTIVE_CAMERA_SET = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));

export const COMMENTARY_SYNC_TOLERANCE_MS = 250;
export const COMMENTARY_OBSERVATION_SECONDS = 120;

export async function loadCommentaryQualification(path, expectedEvent, activeCameras, options = {}) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) {
    throw new Error("commentary qualification must be a protected file");
  }
  await chmod(path, 0o600);
  const content = await readFile(path);
  const qualification = validateCommentaryQualification(JSON.parse(content), expectedEvent, activeCameras);
  if (options.requireInstalled === true && !qualification.installation) {
    throw new Error("commentary qualification is not installed for this event generation");
  }
  if (options.lifecycleGenerationId !== undefined && qualification.installation?.lifecycleGenerationId !== options.lifecycleGenerationId) {
    throw new Error("commentary qualification belongs to a different lifecycle generation");
  }
  return {
    qualification,
    sha256: createHash("sha256").update(content).digest("hex"),
    ...evaluateCommentaryQualification(qualification, activeCameras)
  };
}

export function validateCommentaryQualification(value, expectedEvent = null, activeCameras = null) {
  if (!value || value.schemaVersion !== 2) throw new Error("commentary qualification schemaVersion must be 2");
  if (!EVENT_SLUG.test(value.event ?? "")) throw new Error("commentary qualification event is invalid");
  if (expectedEvent !== null && value.event !== expectedEvent) throw new Error("commentary qualification belongs to a different event");
  if (!new Set(["PENDING", "QUALIFIED"]).has(value.status)) throw new Error("commentary qualification status is invalid");
  if (!Array.isArray(value.courts)) throw new Error("commentary qualification courts are required");
  const expected = normalizeActiveCameras(activeCameras ?? value.courts.map((entry) => entry?.cameraNumber));
  if (JSON.stringify(value.courts.map((entry) => entry?.cameraNumber)) !== JSON.stringify(expected)) {
    throw new Error("commentary qualification must contain active cameras in order exactly once");
  }
  if (value.status === "PENDING") {
    if (value.turnTls !== null || value.installation !== undefined) throw new Error("pending commentary qualification cannot contain observations or installation evidence");
    for (const court of value.courts) {
      if (JSON.stringify(Object.keys(court).sort()) !== JSON.stringify(["cameraNumber", "status"]) || court.status !== "PENDING") {
        throw new Error(`Camera ${court?.cameraNumber ?? "unknown"} pending commentary qualification is invalid`);
      }
    }
    return value;
  }
  validateTurnTls(value.turnTls);
  for (const court of value.courts) validateCourt(court);
  if (value.installation !== undefined) validateInstallation(value.installation);
  return value;
}

export function evaluateCommentaryQualification(value, activeCameras = null) {
  const qualification = validateCommentaryQualification(value, null, activeCameras);
  if (qualification.status === "PENDING") return { passed: false, problems: ["commentary qualification is pending"] };
  const problems = [];
  if (qualification.turnTls.connected !== true) problems.push("commentary TURN/TLS fallback did not connect");
  if (qualification.turnTls.observationSeconds < COMMENTARY_OBSERVATION_SECONDS) problems.push("commentary TURN/TLS fallback observation was too short");
  for (const court of qualification.courts) {
    const prefix = `Camera ${court.cameraNumber}`;
    if (court.returnFeed.observationSeconds < COMMENTARY_OBSERVATION_SECONDS) problems.push(`${prefix} commentary return-feed observation was too short`);
    if (!court.returnFeed.videoContinuous || !court.returnFeed.ambienceAudible) problems.push(`${prefix} commentary return feed was incomplete`);
    if (!court.mixMinus.twoCommentators || !court.mixMinus.selfMicrophoneAbsent || !court.mixMinus.otherCommentatorAudible || !court.mixMinus.headphonesConfirmed) problems.push(`${prefix} commentary mix-minus did not pass`);
    if (!court.continuity.lateJoinPassed || !court.continuity.dropRejoinPassed || !court.continuity.videoAndAmbienceContinued || !court.continuity.outputAudioTrackContinuous) problems.push(`${prefix} commentary continuity did not pass`);
    if (court.encodedAudio.codec !== "AAC" || court.encodedAudio.channels !== 2 || court.encodedAudio.sampleRateHz !== 48_000 || court.encodedAudio.bitrateBps !== 128_000 || court.encodedAudio.monoChannelDifferenceDb > 1) problems.push(`${prefix} commentary encoded-audio contract did not pass`);
    const offsets = [court.calibration.beginningOffsetMs, court.calibration.middleOffsetMs, court.calibration.endOffsetMs];
    if (!court.calibration.passed || offsets.some((offset) => Math.abs(offset) > COMMENTARY_SYNC_TOLERANCE_MS)) problems.push(`${prefix} commentary clap calibration exceeded ${COMMENTARY_SYNC_TOLERANCE_MS} ms`);
    if (court.calibration.materialPathChangedAfterCalibration) problems.push(`${prefix} commentary path changed after calibration`);
  }
  return { passed: problems.length === 0, problems };
}

export function createSyntheticCommentaryQualification(event, activeCameras = ACTIVE_CAMERA_SET) {
  const cameras = normalizeActiveCameras(activeCameras);
  const observedAt = "2026-01-01T00:00:00.000Z";
  return validateCommentaryQualification({
    schemaVersion: 2,
    event,
    status: "QUALIFIED",
    turnTls: {
      testedAt: observedAt,
      operator: "isolated-rehearsal",
      network: "udp-blocked-synthetic-fixture",
      udpBlocked: true,
      transport: "turns-tcp-443",
      connected: true,
      observationSeconds: COMMENTARY_OBSERVATION_SECONDS
    },
    courts: cameras.map((cameraNumber) => ({
      cameraNumber,
      assessedAt: observedAt,
      operator: "isolated-rehearsal",
      returnFeed: {
        path: `court${cameraNumber}_preview`,
        observationSeconds: COMMENTARY_OBSERVATION_SECONDS,
        measuredGlassToGlassLatencyMs: 500,
        videoContinuous: true,
        ambienceAudible: true
      },
      mixMinus: {
        twoCommentators: true,
        selfMicrophoneAbsent: true,
        otherCommentatorAudible: true,
        headphonesConfirmed: true
      },
      continuity: {
        lateJoinPassed: true,
        dropRejoinPassed: true,
        videoAndAmbienceContinued: true,
        outputAudioTrackContinuous: true
      },
      encodedAudio: {
        codec: "AAC",
        channels: 2,
        sampleRateHz: 48_000,
        bitrateBps: 128_000,
        monoChannelDifferenceDb: 0
      },
      calibration: {
        method: "visible-clap",
        observedAt,
        beginningOffsetMs: 0,
        middleOffsetMs: 0,
        endOffsetMs: 0,
        passed: true,
        materialPathChangedAfterCalibration: false
      }
    }))
  }, event, cameras);
}

export function createPendingCommentaryQualification(event, activeCameras = ACTIVE_CAMERA_SET) {
  const cameras = normalizeActiveCameras(activeCameras);
  return validateCommentaryQualification({
    schemaVersion: 2,
    event,
    status: "PENDING",
    turnTls: null,
    courts: cameras.map((cameraNumber) => ({ cameraNumber, status: "PENDING" }))
  }, event, cameras);
}

function validateTurnTls(value) {
  validateObservationIdentity(value, "TURN/TLS");
  if (!SAFE_TEXT.test(value.network ?? "")) throw new Error("commentary TURN/TLS network is invalid");
  if (value.udpBlocked !== true || value.transport !== "turns-tcp-443") throw new Error("commentary TURN/TLS test must block UDP and use turns-tcp-443");
  if (typeof value.connected !== "boolean") throw new Error("commentary TURN/TLS connection result is invalid");
  validateObservationSeconds(value.observationSeconds, "commentary TURN/TLS");
}

function validateCourt(value) {
  if (!Number.isInteger(value?.cameraNumber) || value.cameraNumber < 1 || value.cameraNumber > 8) throw new Error("commentary court camera number is invalid");
  validateObservationIdentity(value, `Camera ${value.cameraNumber}`);
  const number = value.cameraNumber;
  if (value.returnFeed?.path !== `court${number}_preview`) throw new Error(`Camera ${number} commentary return path is invalid`);
  validateObservationSeconds(value.returnFeed?.observationSeconds, `Camera ${number} commentary return feed`);
  if (!Number.isFinite(value.returnFeed?.measuredGlassToGlassLatencyMs) || value.returnFeed.measuredGlassToGlassLatencyMs < 0 || value.returnFeed.measuredGlassToGlassLatencyMs > 5_000) throw new Error(`Camera ${number} commentary return latency is invalid`);
  for (const [group, fields] of Object.entries({
    returnFeed: ["videoContinuous", "ambienceAudible"],
    mixMinus: ["twoCommentators", "selfMicrophoneAbsent", "otherCommentatorAudible", "headphonesConfirmed"],
    continuity: ["lateJoinPassed", "dropRejoinPassed", "videoAndAmbienceContinued", "outputAudioTrackContinuous"]
  })) {
    for (const field of fields) if (typeof value[group]?.[field] !== "boolean") throw new Error(`Camera ${number} commentary ${group}.${field} is invalid`);
  }
  const audio = value.encodedAudio;
  if (!audio || audio.codec !== "AAC" || !Number.isInteger(audio.channels) || !Number.isInteger(audio.sampleRateHz) || !Number.isInteger(audio.bitrateBps) || !Number.isFinite(audio.monoChannelDifferenceDb) || audio.monoChannelDifferenceDb < 0 || audio.monoChannelDifferenceDb > 120) throw new Error(`Camera ${number} commentary encoded audio evidence is invalid`);
  const calibration = value.calibration;
  if (!calibration || calibration.method !== "visible-clap" || !ISO_TIMESTAMP.test(calibration.observedAt ?? "") || !Number.isFinite(Date.parse(calibration.observedAt))) throw new Error(`Camera ${number} commentary calibration identity is invalid`);
  for (const field of ["beginningOffsetMs", "middleOffsetMs", "endOffsetMs"]) if (!Number.isFinite(calibration[field]) || Math.abs(calibration[field]) > 10_000) throw new Error(`Camera ${number} commentary ${field} is invalid`);
  if (typeof calibration.passed !== "boolean" || typeof calibration.materialPathChangedAfterCalibration !== "boolean") throw new Error(`Camera ${number} commentary calibration result is invalid`);
}

function validateObservationIdentity(value, label) {
  if (!value || !ISO_TIMESTAMP.test(value.testedAt ?? value.assessedAt ?? "") || !Number.isFinite(Date.parse(value.testedAt ?? value.assessedAt))) throw new Error(`${label} commentary observation timestamp is invalid`);
  if (!SAFE_TEXT.test(value.operator ?? "")) throw new Error(`${label} commentary operator is invalid`);
}

function validateObservationSeconds(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 86_400) throw new Error(`${label} observation duration is invalid`);
}

function validateInstallation(value) {
  if (!value || !ISO_TIMESTAMP.test(value.installedAt ?? "") || !Number.isFinite(Date.parse(value.installedAt))) throw new Error("commentary qualification installation timestamp is invalid");
  if (!/^[A-Za-z0-9-]{8,100}$/u.test(value.lifecycleGenerationId ?? "")) throw new Error("commentary qualification lifecycle generation is invalid");
  if (!/^[a-f0-9]{64}$/u.test(value.sourceSha256 ?? "")) throw new Error("commentary qualification source digest is invalid");
}

function normalizeActiveCameras(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some((camera) => !Number.isInteger(camera) || camera < 1 || camera > 8)) throw new Error("commentary active cameras are invalid");
  const normalized = [...new Set(value)].sort((left, right) => left - right);
  if (normalized.length !== value.length || JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error("commentary active cameras must be unique and ordered");
  return normalized;
}
