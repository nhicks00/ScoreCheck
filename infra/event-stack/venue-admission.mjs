import { createHash } from "node:crypto";
import { chmod, readFile, stat } from "node:fs/promises";

const CAMERA_NUMBERS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));
const SAFE_DECLARATION = /^[A-Za-z0-9][A-Za-z0-9 ._()+/-]{0,79}$/u;
const EVENT_SLUG = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export const VENUE_RESERVE_FRACTION = 0.3;
export const VENUE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const VENUE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const VENUE_SOURCE_PROFILES = Object.freeze({
  CONSTRAINED_1080P30: Object.freeze({
    outputProfile: "1080p30",
    frameRateModes: Object.freeze(["30000/1001", "30/1"]),
    minimumSourceBitrateBps: 3_500_000,
    maximumSourceBitrateBps: 6_000_000
  }),
  STANDARD_1080P30: Object.freeze({
    outputProfile: "1080p30",
    frameRateModes: Object.freeze(["30000/1001", "30/1"]),
    minimumSourceBitrateBps: 5_000_000,
    maximumSourceBitrateBps: 8_000_000
  }),
  PRIORITY_1080P60: Object.freeze({
    outputProfile: "1080p60",
    frameRateModes: Object.freeze(["60000/1001", "60/1"]),
    minimumSourceBitrateBps: 8_000_000,
    maximumSourceBitrateBps: 12_000_000
  })
});

const SOURCE_PATH_MODES = new Set(["direct-h264", "isolated-hevc-normalizer"]);
const SOURCE_PROTOCOLS = new Set(["SRT_ENCRYPTED", "RTMPS", "RTMP_LEGACY_APPROVED"]);
const VENUE_LINKS = new Set(["WIRED_ETHERNET", "DEDICATED_WIFI"]);

export async function loadVenueAdmission(path, expectedEvent) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error("venue profile must be a protected file");
  await chmod(path, 0o600);
  const content = await readFile(path);
  const profile = validateVenueProfile(JSON.parse(content), expectedEvent);
  return {
    profile,
    sha256: createHash("sha256").update(content).digest("hex"),
    ...evaluateVenueAdmission(profile)
  };
}

export function validateVenueProfile(value, expectedEvent = null) {
  if (!value || value.schemaVersion !== 1) throw new Error("venue profile schemaVersion must be 1");
  if (!EVENT_SLUG.test(value.event ?? "")) throw new Error("venue profile event is invalid");
  if (expectedEvent !== null && value.event !== expectedEvent) throw new Error("venue profile belongs to a different event");
  if (value.reserveFraction !== VENUE_RESERVE_FRACTION) throw new Error(`venue profile reserveFraction must be ${VENUE_RESERVE_FRACTION}`);
  validateUploadMeasurement(value.uploadMeasurement);
  validatePhysicalReadiness(value.physicalReadiness);
  if (!Array.isArray(value.cameras) || value.cameras.length !== 8) throw new Error("venue profile must contain exactly eight permanent cameras");
  const numbers = value.cameras.map((camera) => camera?.cameraNumber);
  if (JSON.stringify(numbers) !== JSON.stringify(CAMERA_NUMBERS)) throw new Error("venue profile cameras must be ordered Camera 1 through Camera 8 exactly once");
  for (const camera of value.cameras) validateCamera(camera);
  if (!value.cameras.some((camera) => camera.enabled)) throw new Error("venue profile must enable at least one camera");
  return value;
}

export function evaluateVenueAdmission(profileInput, nowMs = Date.now()) {
  const profile = validateVenueProfile(profileInput);
  if (!Number.isFinite(nowMs)) throw new Error("venue admission time is invalid");
  const active = profile.cameras.filter((camera) => camera.enabled);
  const inactive = profile.cameras.filter((camera) => !camera.enabled);
  const assignments = Object.fromEntries(active.map((camera) => {
    const source = VENUE_SOURCE_PROFILES[camera.sourceProfile];
    return [camera.cameraNumber, {
      ...camera,
      outputProfile: source.outputProfile,
      minimumSourceBitrateBps: source.minimumSourceBitrateBps,
      maximumSourceBitrateBps: source.maximumSourceBitrateBps
    }];
  }));
  const aggregateMaximumSourceBitrateBps = Object.values(assignments)
    .reduce((sum, camera) => sum + camera.maximumSourceBitrateBps, 0);
  const requiredSustainedUploadMbps = aggregateMaximumSourceBitrateBps * (1 + profile.reserveFraction) / 1_000_000;
  const validatedSustainedUploadMbps = profile.uploadMeasurement.sustainedUploadMbps;
  const problems = [];
  const uploadMeasuredAtMs = Date.parse(profile.uploadMeasurement.measuredAt);
  const physicalAssessedAtMs = Date.parse(profile.physicalReadiness.assessedAt);
  for (const [label, observedAtMs] of [["bonded upload measurement", uploadMeasuredAtMs], ["physical readiness assessment", physicalAssessedAtMs]]) {
    const ageMs = nowMs - observedAtMs;
    if (ageMs < -VENUE_CLOCK_SKEW_MS) problems.push(`${label} is more than five minutes in the future`);
    else if (ageMs > VENUE_EVIDENCE_MAX_AGE_MS) problems.push(`${label} is older than 24 hours`);
  }
  if (validatedSustainedUploadMbps < requiredSustainedUploadMbps) {
    problems.push(`validated bonded upload ${validatedSustainedUploadMbps.toFixed(1)} Mbps is below the event requirement ${requiredSustainedUploadMbps.toFixed(1)} Mbps`);
  }
  return {
    activeCameras: active.map((camera) => camera.cameraNumber),
    inactiveCameras: inactive.map((camera) => camera.cameraNumber),
    assignments,
    aggregateMaximumSourceBitrateBps,
    requiredSustainedUploadMbps,
    requiredSustainedUploadMbpsRounded: Math.ceil(requiredSustainedUploadMbps),
    validatedSustainedUploadMbps,
    uploadMeasurementAgeMs: nowMs - uploadMeasuredAtMs,
    physicalReadinessAgeMs: nowMs - physicalAssessedAtMs,
    reserveFraction: profile.reserveFraction,
    headroomMbps: validatedSustainedUploadMbps - requiredSustainedUploadMbps,
    problems,
    passed: problems.length === 0
  };
}

export function createSyntheticRehearsalVenueProfile(event, now = new Date()) {
  const observedAt = now.toISOString();
  const profile = {
    schemaVersion: 1,
    event,
    reserveFraction: VENUE_RESERVE_FRACTION,
    uploadMeasurement: {
      measuredAt: observedAt,
      durationSeconds: 300,
      sustainedUploadMbps: 100,
      bonded: true,
      routerIdentity: "isolated-rehearsal-source"
    },
    cameras: CAMERA_NUMBERS.map((cameraNumber) => ({
      cameraNumber,
      cameraIdentity: `camera-${cameraNumber}`,
      publishPath: `court${cameraNumber}_raw`,
      enabled: true,
      cameraModel: "Pinned FFmpeg Fixture",
      cameraFirmware: "Git Pinned Fixture",
      sourceProtocol: "SRT_ENCRYPTED",
      sourcePathMode: "direct-h264",
      sourceCodec: "H264",
      sourceProfile: "STANDARD_1080P30",
      frameRateMode: "30/1",
      venueLink: "WIRED_ETHERNET",
      sourceRateCapMbps: 8,
      powerProtected: true,
      legacyTransportApproved: false
    })),
    physicalReadiness: {
      assessedAt: observedAt,
      operator: "isolated-rehearsal",
      cameraNetworkIsolated: true,
      operatorNetworkSeparated: true,
      qosFairnessConfigured: true,
      rfSurveyPassed: true,
      routerTemperatureC: 35,
      routerTemperatureLimitC: 75,
      upsRuntimeMinutes: 60,
      starlinkObstructionPassed: true,
      cellularWanCount: 1,
      weatherProtectionReady: true,
      sparePowerAndCablesReady: true
    }
  };
  return validateVenueProfile(profile, event);
}

function validateUploadMeasurement(value) {
  if (!value || !ISO_TIMESTAMP.test(value.measuredAt ?? "") || !Number.isFinite(Date.parse(value.measuredAt))) throw new Error("venue upload measurement timestamp is invalid");
  if (!Number.isInteger(value.durationSeconds) || value.durationSeconds < 60) throw new Error("venue upload measurement must run for at least 60 seconds");
  if (!Number.isFinite(value.sustainedUploadMbps) || value.sustainedUploadMbps <= 0 || value.sustainedUploadMbps > 10_000) throw new Error("venue sustained upload measurement is invalid");
  if (value.bonded !== true) throw new Error("venue upload measurement must use the bonded event route");
  if (!SAFE_DECLARATION.test(value.routerIdentity ?? "")) throw new Error("venue router identity is invalid");
}

function validatePhysicalReadiness(value) {
  if (!value || !ISO_TIMESTAMP.test(value.assessedAt ?? "") || !Number.isFinite(Date.parse(value.assessedAt))) throw new Error("venue physical-readiness timestamp is invalid");
  if (!SAFE_DECLARATION.test(value.operator ?? "")) throw new Error("venue physical-readiness operator is invalid");
  for (const field of ["cameraNetworkIsolated", "operatorNetworkSeparated", "qosFairnessConfigured", "rfSurveyPassed", "starlinkObstructionPassed", "weatherProtectionReady", "sparePowerAndCablesReady"]) {
    if (value[field] !== true) throw new Error(`venue physical readiness requires ${field}`);
  }
  if (!Number.isFinite(value.routerTemperatureC) || !Number.isFinite(value.routerTemperatureLimitC)
    || value.routerTemperatureC < -20 || value.routerTemperatureLimitC < 40 || value.routerTemperatureLimitC > 100
    || value.routerTemperatureC > value.routerTemperatureLimitC) throw new Error("venue router thermal check is invalid or over limit");
  if (!Number.isInteger(value.upsRuntimeMinutes) || value.upsRuntimeMinutes < 30 || value.upsRuntimeMinutes > 1_440) throw new Error("venue UPS runtime must be at least 30 minutes");
  if (!Number.isInteger(value.cellularWanCount) || value.cellularWanCount < 1 || value.cellularWanCount > 8) throw new Error("venue must have at least one cellular WAN in the bonded route");
}

function validateCamera(camera) {
  const number = camera?.cameraNumber;
  if (!Number.isInteger(number) || number < 1 || number > 8) throw new Error("venue camera number is invalid");
  if (camera.cameraIdentity !== `camera-${number}`) throw new Error(`Camera ${number} identity must be camera-${number}`);
  if (camera.publishPath !== `court${number}_raw`) throw new Error(`Camera ${number} publish path must be court${number}_raw`);
  if (typeof camera.enabled !== "boolean") throw new Error(`Camera ${number} enabled state is invalid`);
  if (!camera.enabled) {
    const expected = ["cameraNumber", "cameraIdentity", "publishPath", "enabled"].sort();
    if (JSON.stringify(Object.keys(camera).sort()) !== JSON.stringify(expected)) throw new Error(`disabled Camera ${number} must not carry an active source assignment`);
    return;
  }
  for (const field of ["cameraModel", "cameraFirmware"]) {
    if (!SAFE_DECLARATION.test(camera[field] ?? "") || /^(?:unknown|replace|unverified|example)/iu.test(camera[field])) throw new Error(`Camera ${number} ${field} is not an installed value`);
  }
  if (!SOURCE_PROTOCOLS.has(camera.sourceProtocol)) throw new Error(`Camera ${number} source protocol is invalid`);
  if (camera.sourceProtocol === "RTMP_LEGACY_APPROVED" ? camera.legacyTransportApproved !== true : camera.legacyTransportApproved !== false) {
    throw new Error(`Camera ${number} legacy transport approval does not match its source protocol`);
  }
  if (!SOURCE_PATH_MODES.has(camera.sourcePathMode)) throw new Error(`Camera ${number} source path mode is invalid`);
  if (camera.sourcePathMode === "direct-h264" && camera.sourceCodec !== "H264") throw new Error(`Camera ${number} direct browser path requires H264`);
  if (camera.sourcePathMode === "isolated-hevc-normalizer" && camera.sourceCodec !== "H265") throw new Error(`Camera ${number} isolated normalizer requires H265 input`);
  const source = VENUE_SOURCE_PROFILES[camera.sourceProfile];
  if (!source) throw new Error(`Camera ${number} source profile is invalid`);
  if (!source.frameRateModes.includes(camera.frameRateMode)) throw new Error(`Camera ${number} frame rate does not match ${camera.sourceProfile}`);
  if (!VENUE_LINKS.has(camera.venueLink)) throw new Error(`Camera ${number} venue link is invalid`);
  if (!Number.isFinite(camera.sourceRateCapMbps) || camera.sourceRateCapMbps !== source.maximumSourceBitrateBps / 1_000_000) throw new Error(`Camera ${number} source rate cap must match ${camera.sourceProfile}`);
  if (camera.powerProtected !== true) throw new Error(`Camera ${number} power is not protected`);
}

export { CAMERA_NUMBERS };
