import {
  parseVisionOutboxPayload,
  verifyVisionShadowDispatch,
  VisionShadowError,
  type ValidatedVisionOutboxPayload,
  type VisionDispatchTrustPolicy,
  type VisionEventSummary,
  type VisionPostStateSummary
} from "./transport";

export interface FixedVisionReceiptReadRpcArguments {
  readonly p_source_ledger_id: string;
  readonly p_source_match_id: string;
}

export type FixedVisionReceiptReadRpc = (
  arguments_: FixedVisionReceiptReadRpcArguments
) => Promise<{
  readonly data: readonly { readonly record: unknown }[] | null;
  readonly error: { readonly message: string } | null;
}>;

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DOMAIN_ID = /^[!-~]{1,128}$/;
const MESSAGE_ID = /^[!-~]{1,192}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_SIGNED_64 = BigInt("9223372036854775807");
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 512;
const MAX_VISION_RECEIPTS_PER_MATCH = 4096;
const MAX_FIXED_READ_WIRE_BYTES = 48 * 1024 * 1024;

export type VisionProjectionBlockCode =
  | "RECEIPT_TAMPERED"
  | "DISPATCH_KEY_REVOKED"
  | "SOURCE_IDENTITY_CONFLICT"
  | "IDENTITY_CONFLICT"
  | "SOURCE_REVISION_GAP"
  | "SOURCE_LINEAGE_CONFLICT"
  | "RECEIPT_BOUND_EXCEEDED"
  | "HISTORICAL_TRUST_UNAVAILABLE";

export interface VisionHistoricalTrustQuery {
  readonly sourceLedgerId: string;
  readonly dispatcherId: string;
  readonly dispatcherKeyId: string;
  readonly receivedAtNs: string;
}

/** Protected receipt-time policy snapshot plus retained revocation truth. */
export type VisionHistoricalTrustResolver = (
  query: VisionHistoricalTrustQuery
) => VisionDispatchTrustPolicy | null;

export interface VisionShadowProjection {
  readonly status: "EMPTY" | "VERIFIED_RECEIPT_PREFIX" | "INTEGRITY_BLOCKED";
  readonly blockCode: VisionProjectionBlockCode | null;
  readonly sourceLedgerId: string | null;
  readonly sourceMatchId: string | null;
  readonly lastContiguousRevision: string;
  readonly latestEventId: string | null;
  readonly latestEventSummary: VisionEventSummary | null;
  readonly latestPostStateSummary: VisionPostStateSummary | null;
  readonly reducerBuildSha256: string | null;
  readonly rulesetId: string | null;
  readonly rulesetVersion: string | null;
  readonly rulesetFingerprint: string | null;
}

interface VisionShadowReceiptRecord {
  readonly sourceLedgerId: string;
  readonly outboxId: string;
  readonly messageId: string;
  readonly sourceMatchId: string;
  readonly sourceRevision: string;
  readonly sourceEventId: string;
  readonly sourcePayloadCanonicalAscii: string;
  readonly payloadSha256: string;
  readonly transportEnvelopeCanonicalAscii: string;
  readonly transportEnvelopeSha256: string;
  readonly dispatcherId: string;
  readonly dispatcherKeyId: string;
  readonly dispatchAttemptId: string;
  readonly dispatchSignedAtNs: string;
  readonly dispatchExpiresAtNs: string;
  readonly receivedAtNs: string;
}

const META_FIELDS = [
  "integrity_block_code",
  "row_kind",
  "schema_version",
  "source_ledger_id",
  "source_match_id"
] as const;

const RECEIPT_FIELDS = [
  "adopted_archive_fingerprint",
  "appended_at_ns",
  "authorization_record_fingerprint",
  "dispatch_attempt_id",
  "dispatch_expires_at_ns",
  "dispatch_signed_at_ns",
  "dispatcher_id",
  "dispatcher_key_id",
  "event_fingerprint",
  "event_summary",
  "event_type",
  "integrity_block_code",
  "message_id",
  "outbox_id",
  "payload_sha256",
  "post_state_summary",
  "received_at_ns",
  "reducer_build_sha256",
  "review_authorization_context_fingerprint",
  "review_history_head_sha256",
  "review_position",
  "row_kind",
  "ruleset_fingerprint",
  "ruleset_id",
  "ruleset_version",
  "schema_version",
  "scorer_copilot_case_fingerprint",
  "scorer_copilot_case_link_fingerprint",
  "scorer_copilot_signed_case_fingerprint",
  "source_envelope_fingerprint",
  "source_event_id",
  "source_ledger_id",
  "source_match_id",
  "source_payload_base64",
  "source_revision",
  "state_fingerprint",
  "transport_envelope_base64",
  "transport_envelope_sha256"
] as const;

type JsonValue = string | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function fail(message: string): never {
  throw new Error(`VISION_RECEIPT_READ_CONTRACT: ${message}`);
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const present = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (present.length !== expected.length || present.some((field, index) => field !== expected[index])) {
    fail(`${label} fields differ from the fixed contract`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : exactString(value, label);
}

function decimal(value: unknown, label: string, minimum: bigint): string {
  const text = exactString(value, label);
  if (!DECIMAL.test(text)) fail(`${label} must be a canonical decimal string`);
  const parsed = BigInt(text);
  if (parsed < minimum || parsed > MAX_SIGNED_64) fail(`${label} exceeds signed-64 bounds`);
  return text;
}

function hash(value: unknown, label: string): string {
  const text = exactString(value, label);
  if (!SHA256.test(text)) fail(`${label} must be a lowercase SHA-256`);
  return text;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function canonicalBase64(value: unknown, label: string, maximum: number): Buffer {
  const text = exactString(value, label);
  if (!text || !BASE64.test(text)) fail(`${label} must be canonical base64`);
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text || bytes.byteLength < 1 || bytes.byteLength > maximum) {
    fail(`${label} exceeds its canonical byte bound`);
  }
  return bytes;
}

function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function normalizedJson(value: unknown, label: string): string {
  let nodes = 0;
  const visit = (current: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) fail(`${label} exceeds its JSON node bound`);
    if (typeof current === "number" || typeof current === "bigint") {
      fail(`${label} contains a numeric value instead of canonical decimal text`);
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (depth >= MAX_JSON_DEPTH) fail(`${label} exceeds its JSON depth bound`);
    if (Array.isArray(current)) return current.map((child) => visit(child, depth + 1));
    if (typeof current === "object") {
      const object = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(object).map(([key, child]) => [key, visit(child, depth + 1)])
      );
    }
    fail(`${label} contains an unsupported JSON value`);
  };
  return canonicalJson(visit(value, 0));
}

function stableId(value: unknown, label: string): string {
  const text = exactString(value, label);
  if (!STABLE_ID.test(text)) fail(`${label} must be a stable ID`);
  return text;
}

function readReceipt(
  raw: unknown,
  expectedLedgerId: string,
  expectedMatchId: string
): VisionShadowReceiptRecord {
  const row = exactObject(raw, RECEIPT_FIELDS, "receipt row");
  if (row.schema_version !== "1.0" || row.row_kind !== "RECEIPT" || row.integrity_block_code !== null) {
    fail("receipt row literals are invalid");
  }
  const sourceLedgerId = stableId(row.source_ledger_id, "source_ledger_id");
  const sourceMatchId = stableId(row.source_match_id, "source_match_id");
  if (sourceLedgerId !== expectedLedgerId || sourceMatchId !== expectedMatchId) {
    fail("receipt row escaped the fixed source query");
  }
  const sourcePayload = canonicalBase64(row.source_payload_base64, "source_payload_base64", 16 * 1024);
  const transportEnvelope = canonicalBase64(
    row.transport_envelope_base64,
    "transport_envelope_base64",
    32 * 1024
  );
  let payload: ValidatedVisionOutboxPayload;
  try {
    payload = parseVisionOutboxPayload(sourcePayload);
  } catch {
    fail("source payload bytes fail the frozen transport contract");
  }

  const outboxId = decimal(row.outbox_id, "outbox_id", BigInt(1));
  const sourceRevision = decimal(row.source_revision, "source_revision", BigInt(1));
  const sourceEventId = exactString(row.source_event_id, "source_event_id");
  if (!DOMAIN_ID.test(sourceEventId)) fail("source_event_id is invalid");
  const storedMessageId = exactString(row.message_id, "message_id");
  if (!MESSAGE_ID.test(storedMessageId)) fail("message_id is invalid");
  const appendedAtNs = decimal(row.appended_at_ns, "appended_at_ns", BigInt(0));
  const eventType = exactString(row.event_type, "event_type");
  const eventSummary = normalizedJson(row.event_summary, "event_summary");
  const postStateSummary = normalizedJson(row.post_state_summary, "post_state_summary");

  const scorerCopilotCaseFingerprint = nullableHash(
    row.scorer_copilot_case_fingerprint,
    "scorer_copilot_case_fingerprint"
  );
  const scorerCopilotSignedCaseFingerprint = nullableHash(
    row.scorer_copilot_signed_case_fingerprint,
    "scorer_copilot_signed_case_fingerprint"
  );
  const scorerCopilotCaseLinkFingerprint = nullableHash(
    row.scorer_copilot_case_link_fingerprint,
    "scorer_copilot_case_link_fingerprint"
  );
  const reviewAuthorizationContextFingerprint = nullableHash(
    row.review_authorization_context_fingerprint,
    "review_authorization_context_fingerprint"
  );
  if (
    outboxId !== payload.outboxId ||
    storedMessageId !== payload.messageId ||
    sourceRevision !== payload.sourceRevision ||
    sourceEventId !== payload.sourceEventId ||
    appendedAtNs !== payload.appendedAtNs ||
    eventType !== payload.eventSummary.eventType ||
    eventSummary !== payload.eventSummaryDecimalJson ||
    postStateSummary !== payload.postStateSummaryDecimalJson ||
    hash(row.payload_sha256, "payload_sha256") !== payload.payloadSha256 ||
    exactString(row.ruleset_id, "ruleset_id") !== payload.rulesetId ||
    exactString(row.ruleset_version, "ruleset_version") !== payload.rulesetVersion ||
    hash(row.ruleset_fingerprint, "ruleset_fingerprint") !== payload.rulesetFingerprint ||
    hash(row.reducer_build_sha256, "reducer_build_sha256") !== payload.reducerBuildSha256 ||
    hash(row.adopted_archive_fingerprint, "adopted_archive_fingerprint") !==
      payload.adoptedArchiveFingerprint ||
    hash(row.authorization_record_fingerprint, "authorization_record_fingerprint") !==
      payload.authorizationRecordFingerprint ||
    hash(row.source_envelope_fingerprint, "source_envelope_fingerprint") !==
      payload.envelopeFingerprint ||
    hash(row.event_fingerprint, "event_fingerprint") !== payload.eventFingerprint ||
    hash(row.state_fingerprint, "state_fingerprint") !== payload.stateFingerprint ||
    hash(row.review_history_head_sha256, "review_history_head_sha256") !==
      payload.reviewHistoryHeadSha256 ||
    decimal(row.review_position, "review_position", BigInt(0)) !== payload.reviewPosition ||
    scorerCopilotCaseFingerprint !== payload.scorerCopilotCaseFingerprint ||
    scorerCopilotSignedCaseFingerprint !== payload.scorerCopilotSignedCaseFingerprint ||
    scorerCopilotCaseLinkFingerprint !== payload.scorerCopilotCaseLinkFingerprint ||
    reviewAuthorizationContextFingerprint !== payload.reviewAuthorizationContextFingerprint
  ) {
    fail("derived receipt columns do not bind the exact source payload");
  }
  return Object.freeze({
    sourceLedgerId,
    outboxId,
    messageId: storedMessageId,
    sourceMatchId,
    sourceRevision,
    sourceEventId,
    sourcePayloadCanonicalAscii: sourcePayload.toString("ascii"),
    payloadSha256: payload.payloadSha256,
    transportEnvelopeCanonicalAscii: transportEnvelope.toString("ascii"),
    transportEnvelopeSha256: hash(
      row.transport_envelope_sha256,
      "transport_envelope_sha256"
    ),
    dispatcherId: stableId(row.dispatcher_id, "dispatcher_id"),
    dispatcherKeyId: stableId(row.dispatcher_key_id, "dispatcher_key_id"),
    dispatchAttemptId: stableId(row.dispatch_attempt_id, "dispatch_attempt_id"),
    dispatchSignedAtNs: decimal(row.dispatch_signed_at_ns, "dispatch_signed_at_ns", BigInt(0)),
    dispatchExpiresAtNs: decimal(
      row.dispatch_expires_at_ns,
      "dispatch_expires_at_ns",
      BigInt(0)
    ),
    receivedAtNs: decimal(row.received_at_ns, "received_at_ns", BigInt(0))
  });
}

function boundedWireBytes(value: unknown): number {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  let total = 0;
  const addString = (text: string) => {
    total += Buffer.byteLength(text, "utf8") + 2;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) total += 1;
      else if (code < 0x20) total += 5;
    }
    if (total > MAX_FIXED_READ_WIRE_BYTES) {
      fail("fixed read response exceeds its wire-byte bound");
    }
  };
  while (stack.length > 0) {
    const current = stack.pop();
    total += 1;
    if (total > MAX_FIXED_READ_WIRE_BYTES) fail("fixed read response exceeds its wire-byte bound");
    if (typeof current === "string") {
      addString(current);
    } else if (typeof current === "number" || typeof current === "bigint") {
      total += 24;
    } else if (Array.isArray(current)) {
      if (seen.has(current)) fail("fixed read response contains a cycle");
      seen.add(current);
      if (current.length > MAX_FIXED_READ_WIRE_BYTES) {
        fail("fixed read response exceeds its wire-byte bound");
      }
      for (const child of current) stack.push(child);
    } else if (typeof current === "object" && current !== null) {
      if (seen.has(current)) fail("fixed read response contains a cycle");
      seen.add(current);
      for (const [key, child] of Object.entries(current)) {
        addString(key);
        stack.push(child);
      }
    }
  }
  if (total > MAX_FIXED_READ_WIRE_BYTES) fail("fixed read response exceeds its wire-byte bound");
  return total;
}

function emptyProjection(): VisionShadowProjection {
  return Object.freeze({
    status: "EMPTY",
    blockCode: null,
    sourceLedgerId: null,
    sourceMatchId: null,
    lastContiguousRevision: "0",
    latestEventId: null,
    latestEventSummary: null,
    latestPostStateSummary: null,
    reducerBuildSha256: null,
    rulesetId: null,
    rulesetVersion: null,
    rulesetFingerprint: null
  });
}

function blocked(
  code: VisionProjectionBlockCode,
  anchor: VisionShadowProjection,
  lastContiguousRevision: string
): VisionShadowProjection {
  return Object.freeze({
    ...anchor,
    status: "INTEGRITY_BLOCKED",
    blockCode: code,
    lastContiguousRevision
  });
}

function receiptScalarsValid(receipt: VisionShadowReceiptRecord): boolean {
  return (
    STABLE_ID.test(receipt.sourceLedgerId) &&
    STABLE_ID.test(receipt.sourceMatchId) &&
    MESSAGE_ID.test(receipt.messageId) &&
    DOMAIN_ID.test(receipt.sourceEventId) &&
    DECIMAL.test(receipt.outboxId) &&
    BigInt(receipt.outboxId) >= BigInt(1) &&
    BigInt(receipt.outboxId) <= MAX_SIGNED_64 &&
    DECIMAL.test(receipt.sourceRevision) &&
    BigInt(receipt.sourceRevision) >= BigInt(1) &&
    BigInt(receipt.sourceRevision) <= MAX_SIGNED_64 &&
    DECIMAL.test(receipt.receivedAtNs) &&
    DECIMAL.test(receipt.dispatchSignedAtNs) &&
    DECIMAL.test(receipt.dispatchExpiresAtNs) &&
    SHA256.test(receipt.payloadSha256) &&
    SHA256.test(receipt.transportEnvelopeSha256) &&
    STABLE_ID.test(receipt.dispatcherId) &&
    STABLE_ID.test(receipt.dispatcherKeyId) &&
    STABLE_ID.test(receipt.dispatchAttemptId) &&
    Buffer.byteLength(receipt.sourcePayloadCanonicalAscii, "ascii") >= 1 &&
    Buffer.byteLength(receipt.sourcePayloadCanonicalAscii, "ascii") <= 16 * 1024 &&
    Buffer.byteLength(receipt.transportEnvelopeCanonicalAscii, "ascii") >= 1 &&
    Buffer.byteLength(receipt.transportEnvelopeCanonicalAscii, "ascii") <= 32 * 1024 &&
    /^[\x00-\x7f]*$/.test(receipt.sourcePayloadCanonicalAscii) &&
    /^[\x00-\x7f]*$/.test(receipt.transportEnvelopeCanonicalAscii)
  );
}

type ReceiptVerificationFailure =
  | "RECEIPT_TAMPERED"
  | "DISPATCH_KEY_REVOKED"
  | "HISTORICAL_TRUST_UNAVAILABLE";

function verificationFailure(error: unknown): ReceiptVerificationFailure {
  if (!(error instanceof VisionShadowError)) return "RECEIPT_TAMPERED";
  if (error.code === "KEY_REVOKED") return "DISPATCH_KEY_REVOKED";
  if (
    ["TRUST_POLICY", "KEY_REGISTRY", "KEY_UNTRUSTED", "KEY_NOT_CURRENT", "KEY_INACTIVE"]
      .includes(error.code)
  ) {
    return "HISTORICAL_TRUST_UNAVAILABLE";
  }
  return "RECEIPT_TAMPERED";
}

function validateReceipt(
  receipt: VisionShadowReceiptRecord,
  resolveHistoricalTrust: VisionHistoricalTrustResolver
):
  | { readonly payload: ValidatedVisionOutboxPayload; readonly error: null }
  | { readonly payload: null; readonly error: ReceiptVerificationFailure } {
  if (!receiptScalarsValid(receipt)) return { payload: null, error: "RECEIPT_TAMPERED" };
  let policy: VisionDispatchTrustPolicy | null;
  try {
    policy = resolveHistoricalTrust({
      sourceLedgerId: receipt.sourceLedgerId,
      dispatcherId: receipt.dispatcherId,
      dispatcherKeyId: receipt.dispatcherKeyId,
      receivedAtNs: receipt.receivedAtNs
    });
  } catch {
    return { payload: null, error: "HISTORICAL_TRUST_UNAVAILABLE" };
  }
  if (policy === null) return { payload: null, error: "HISTORICAL_TRUST_UNAVAILABLE" };
  try {
    const verified = verifyVisionShadowDispatch(
      Buffer.from(receipt.transportEnvelopeCanonicalAscii, "ascii"),
      policy,
      receipt.receivedAtNs
    );
    const payload = verified.payload;
    if (
      verified.sourceLedgerId !== receipt.sourceLedgerId ||
      verified.dispatcherId !== receipt.dispatcherId ||
      verified.dispatcherKeyId !== receipt.dispatcherKeyId ||
      verified.attemptId !== receipt.dispatchAttemptId ||
      verified.signedAtNs !== receipt.dispatchSignedAtNs ||
      verified.expiresAtNs !== receipt.dispatchExpiresAtNs ||
      verified.envelopeSha256 !== receipt.transportEnvelopeSha256 ||
      verified.envelopeCanonicalAscii !== receipt.transportEnvelopeCanonicalAscii ||
      payload.canonicalAscii !== receipt.sourcePayloadCanonicalAscii ||
      payload.payloadSha256 !== receipt.payloadSha256 ||
      payload.outboxId !== receipt.outboxId ||
      payload.messageId !== receipt.messageId ||
      payload.sourceMatchId !== receipt.sourceMatchId ||
      payload.sourceRevision !== receipt.sourceRevision ||
      payload.sourceEventId !== receipt.sourceEventId
    ) {
      return { payload: null, error: "RECEIPT_TAMPERED" };
    }
    return { payload, error: null };
  } catch (error) {
    return { payload: null, error: verificationFailure(error) };
  }
}

function anchorFor(
  receipt: VisionShadowReceiptRecord,
  payload: ValidatedVisionOutboxPayload
): VisionShadowProjection {
  return Object.freeze({
    status: "VERIFIED_RECEIPT_PREFIX",
    blockCode: null,
    sourceLedgerId: receipt.sourceLedgerId,
    sourceMatchId: receipt.sourceMatchId,
    lastContiguousRevision: "0",
    latestEventId: null,
    latestEventSummary: null,
    latestPostStateSummary: null,
    reducerBuildSha256: payload.reducerBuildSha256,
    rulesetId: payload.rulesetId,
    rulesetVersion: payload.rulesetVersion,
    rulesetFingerprint: payload.rulesetFingerprint
  });
}

function replayVerifiedReceipts(
  receipts: readonly VisionShadowReceiptRecord[],
  resolveHistoricalTrust: VisionHistoricalTrustResolver
): VisionShadowProjection {
  if (receipts.length === 0) return emptyProjection();
  if (receipts.length > MAX_VISION_RECEIPTS_PER_MATCH) {
    return blocked("RECEIPT_BOUND_EXCEEDED", emptyProjection(), "0");
  }
  const validated = receipts.map((receipt) => ({
    receipt,
    ...validateReceipt(receipt, resolveHistoricalTrust)
  }));
  const failures = validated.flatMap((item) => item.error === null ? [] : [item.error]);
  const firstValid = validated.find((item) => item.payload !== null);
  if (!firstValid || failures.length > 0) {
    const code: ReceiptVerificationFailure = failures.includes("RECEIPT_TAMPERED")
      ? "RECEIPT_TAMPERED"
      : failures.includes("DISPATCH_KEY_REVOKED")
        ? "DISPATCH_KEY_REVOKED"
        : "HISTORICAL_TRUST_UNAVAILABLE";
    return blocked(code, emptyProjection(), "0");
  }
  const anchor = anchorFor(firstValid.receipt, firstValid.payload!);
  const sorted = [...validated].sort((left, right) => {
    const leftRevision = BigInt(left.receipt.sourceRevision);
    const rightRevision = BigInt(right.receipt.sourceRevision);
    return leftRevision < rightRevision ? -1 : leftRevision > rightRevision ? 1 : 0;
  });
  const outboxIds = new Set<string>();
  const messageIds = new Set<string>();
  const revisions = new Set<string>();
  const eventIds = new Set<string>();
  let expectedRevision = BigInt(1);
  let lastContiguous = BigInt(0);
  let latestPayload = sorted[0].payload!;
  for (const item of sorted) {
    const payload = item.payload!;
    const { receipt } = item;
    if (
      receipt.sourceLedgerId !== anchor.sourceLedgerId ||
      receipt.sourceMatchId !== anchor.sourceMatchId ||
      outboxIds.has(receipt.outboxId) ||
      messageIds.has(receipt.messageId) ||
      revisions.has(receipt.sourceRevision) ||
      eventIds.has(receipt.sourceEventId)
    ) {
      return blocked("SOURCE_IDENTITY_CONFLICT", anchor, lastContiguous.toString(10));
    }
    outboxIds.add(receipt.outboxId);
    messageIds.add(receipt.messageId);
    revisions.add(receipt.sourceRevision);
    eventIds.add(receipt.sourceEventId);
    if (
      payload.reducerBuildSha256 !== anchor.reducerBuildSha256 ||
      payload.rulesetId !== anchor.rulesetId ||
      payload.rulesetVersion !== anchor.rulesetVersion ||
      payload.rulesetFingerprint !== anchor.rulesetFingerprint
    ) {
      return blocked("SOURCE_LINEAGE_CONFLICT", anchor, lastContiguous.toString(10));
    }
    if (BigInt(receipt.sourceRevision) !== expectedRevision) {
      return blocked("SOURCE_REVISION_GAP", anchor, lastContiguous.toString(10));
    }
    lastContiguous = expectedRevision;
    expectedRevision += BigInt(1);
    latestPayload = payload;
  }
  const latestReceipt = sorted[sorted.length - 1].receipt;
  return Object.freeze({
    ...anchor,
    status: "VERIFIED_RECEIPT_PREFIX",
    blockCode: null,
    lastContiguousRevision: lastContiguous.toString(10),
    latestEventId: latestReceipt.sourceEventId,
    latestEventSummary: latestPayload.eventSummary,
    latestPostStateSummary: latestPayload.postStateSummary
  });
}

const TERMINAL_BLOCKS = new Set<VisionProjectionBlockCode>([
  "IDENTITY_CONFLICT",
  "SOURCE_IDENTITY_CONFLICT",
  "SOURCE_LINEAGE_CONFLICT"
]);

function applyTerminalBlock(
  projection: VisionShadowProjection,
  blockCode: VisionProjectionBlockCode | null,
  sourceLedgerId: string,
  sourceMatchId: string
): VisionShadowProjection {
  if (
    blockCode === null ||
    projection.blockCode === "RECEIPT_TAMPERED" ||
    projection.blockCode === "DISPATCH_KEY_REVOKED" ||
    projection.blockCode === "HISTORICAL_TRUST_UNAVAILABLE"
  ) {
    return projection;
  }
  return Object.freeze({
    ...projection,
    status: "INTEGRITY_BLOCKED",
    blockCode,
    sourceLedgerId: projection.sourceLedgerId ?? sourceLedgerId,
    sourceMatchId: projection.sourceMatchId ?? sourceMatchId
  });
}

/**
 * The only consumer read boundary. It never returns receipt rows: every row is
 * shape-checked, rebound to the exact source payload, and signature-replayed
 * against protected historical trust before a projection can escape.
 */
export async function readVerifiedVisionShadowProjection(input: {
  readonly sourceLedgerId: string;
  readonly sourceMatchId: string;
  readonly callFixedReadRpc: FixedVisionReceiptReadRpc;
  readonly resolveHistoricalTrust: VisionHistoricalTrustResolver;
}): Promise<VisionShadowProjection> {
  if (!STABLE_ID.test(input.sourceLedgerId) || !STABLE_ID.test(input.sourceMatchId)) {
    fail("fixed read source identities are invalid");
  }
  if (typeof input.callFixedReadRpc !== "function") fail("fixed read RPC is required");
  if (typeof input.resolveHistoricalTrust !== "function") fail("historical trust resolver is required");

  const result = await input.callFixedReadRpc({
    p_source_ledger_id: input.sourceLedgerId,
    p_source_match_id: input.sourceMatchId
  });
  if (result.error) throw new Error(`VISION_RECEIPT_READ_FAILED: ${result.error.message}`);
  if (!Array.isArray(result.data) || result.data.length < 1 || result.data.length > 4097) {
    fail("fixed read RPC must return one META row and at most 4096 receipts");
  }
  boundedWireBytes(result.data);
  for (const wrapper of result.data) {
    exactObject(wrapper, ["record"], "fixed read wrapper");
  }
  const meta = exactObject(result.data[0].record, META_FIELDS, "META row");
  if (
    meta.schema_version !== "1.0" ||
    meta.row_kind !== "META" ||
    meta.source_ledger_id !== input.sourceLedgerId ||
    meta.source_match_id !== input.sourceMatchId
  ) {
    fail("META row does not bind the fixed read query");
  }
  const blockText = nullableString(meta.integrity_block_code, "integrity_block_code");
  const blockCode = blockText as VisionProjectionBlockCode | null;
  if (blockCode !== null && !TERMINAL_BLOCKS.has(blockCode)) {
    fail("META row has an unsupported integrity block");
  }
  const receipts = result.data
    .slice(1)
    .map((wrapper) => readReceipt(wrapper.record, input.sourceLedgerId, input.sourceMatchId));
  const projection = replayVerifiedReceipts(receipts, input.resolveHistoricalTrust);
  return applyTerminalBlock(
    projection,
    blockCode,
    input.sourceLedgerId,
    input.sourceMatchId
  );
}
