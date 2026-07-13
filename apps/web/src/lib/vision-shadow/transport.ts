import {
  createHash,
  createPublicKey,
  verify as verifyEd25519
} from "node:crypto";

export const VISION_OUTBOX_SCHEMA_VERSION = "2.0";
export const VISION_OUTBOX_TOPIC = "vision_scoring.shadow.authorized_event.v2";
export const VISION_OUTBOX_TARGET = "SHADOW_ONLY_NO_OFFICIAL_SCORECHECK_MUTATION";
export const VISION_DISPATCH_SCHEMA_VERSION = "1.0";
export const VISION_DISPATCH_ALGORITHM = "Ed25519";

export const MAX_VISION_OUTBOX_BYTES = 16 * 1024;
export const MAX_VISION_DISPATCH_BYTES = 32 * 1024;
export const MAX_VISION_JSON_DEPTH = 16;
export const MAX_VISION_JSON_NODES = 512;
export const MAX_VISION_JSON_CONTAINERS = 128;
export const MAX_VISION_DISPATCH_KEYS = 64;

const MAX_SIGNED_64 = BigInt("9223372036854775807");
const MIN_SIGNED_64 = BigInt("-9223372036854775808");
const MAX_REVIEW_POSITION = BigInt(3072);
const MAX_EVIDENCE_COUNT = BigInt(64);
const DISPATCH_SIGNING_DOMAIN = Buffer.from(
  "multicourt-vision-scoring:shadow-dispatch-envelope:v1\u0000",
  "ascii"
);
const EVIDENCE_SET_DOMAIN = Buffer.from(
  "multicourt-vision-scoring:outbox-evidence-set:v1\u0000",
  "ascii"
);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type JsonScalar = string | bigint | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export class VisionShadowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "VisionShadowError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new VisionShadowError(code, message);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function decimalStringJson(value: JsonValue): JsonValue {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(decimalStringJson);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decimalStringJson(child)])
    );
  }
  return value;
}

class CanonicalJsonParser {
  private offset = 0;
  private nodes = 0;
  private containers = 0;

  constructor(private readonly text: string, private readonly label: string) {}

  parseObjectRoot(): JsonObject {
    const value = this.parseValue(0);
    if (this.offset !== this.text.length) {
      fail("INVALID_JSON", `${this.label} contains trailing bytes`);
    }
    if (!isObject(value)) fail("TOP_LEVEL_TYPE", `${this.label} must be an object`);
    if (canonicalJson(value) !== this.text) {
      fail("NON_CANONICAL", `${this.label} must be canonical ASCII JSON`);
    }
    return value;
  }

  private parseValue(parentDepth: number): JsonValue {
    this.nodes += 1;
    if (this.nodes > MAX_VISION_JSON_NODES) {
      fail("JSON_NODES", `${this.label} exceeds its JSON node bound`);
    }
    const token = this.text[this.offset];
    if (token === "{") return this.parseObject(parentDepth + 1);
    if (token === "[") return this.parseArray(parentDepth + 1);
    if (token === "\"") return this.parseString();
    if (token === "t" && this.take("true")) return true;
    if (token === "f" && this.take("false")) return false;
    if (token === "n" && this.take("null")) return null;
    if (token === "-" || (token >= "0" && token <= "9")) return this.parseInteger();
    fail("INVALID_JSON", `${this.label} contains an invalid token`);
  }

  private enterContainer(depth: number): void {
    this.containers += 1;
    if (depth > MAX_VISION_JSON_DEPTH) {
      fail("JSON_DEPTH", `${this.label} exceeds its JSON depth bound`);
    }
    if (this.containers > MAX_VISION_JSON_CONTAINERS) {
      fail("JSON_CONTAINERS", `${this.label} exceeds its container bound`);
    }
  }

  private parseObject(depth: number): JsonObject {
    this.enterContainer(depth);
    this.offset += 1;
    const value: JsonObject = {};
    let previousKey: string | null = null;
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return value;
    }
    while (true) {
      if (this.text[this.offset] !== "\"") {
        fail("INVALID_JSON", `${this.label} object key must be a string`);
      }
      const key = this.parseString();
      if (previousKey !== null && key <= previousKey) {
        const code = key === previousKey ? "DUPLICATE_KEY" : "NON_CANONICAL";
        fail(code, `${this.label} object keys must be unique and sorted`);
      }
      previousKey = key;
      if (this.text[this.offset] !== ":") {
        fail("INVALID_JSON", `${this.label} object key is missing a colon`);
      }
      this.offset += 1;
      value[key] = this.parseValue(depth);
      if (this.text[this.offset] === "}") {
        this.offset += 1;
        return value;
      }
      if (this.text[this.offset] !== ",") {
        fail("INVALID_JSON", `${this.label} object is missing a comma`);
      }
      this.offset += 1;
    }
  }

  private parseArray(depth: number): JsonValue[] {
    this.enterContainer(depth);
    this.offset += 1;
    const value: JsonValue[] = [];
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return value;
    }
    while (true) {
      value.push(this.parseValue(depth));
      if (this.text[this.offset] === "]") {
        this.offset += 1;
        return value;
      }
      if (this.text[this.offset] !== ",") {
        fail("INVALID_JSON", `${this.label} array is missing a comma`);
      }
      this.offset += 1;
    }
  }

  private parseString(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset);
      const character = this.text[this.offset];
      if (!escaped && character === "\"") {
        this.offset += 1;
        const raw = this.text.slice(start, this.offset);
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          fail("INVALID_JSON", `${this.label} contains an invalid string`);
        }
        if (
          typeof value !== "string" ||
          [...value].some((item) => {
            const itemCode = item.charCodeAt(0);
            return itemCode < 0x20 || itemCode > 0x7e;
          }) ||
          JSON.stringify(value) !== raw
        ) {
          fail("NON_CANONICAL", `${this.label} strings must be canonical printable ASCII`);
        }
        return value;
      }
      if (!escaped && code < 0x20) {
        fail("INVALID_JSON", `${this.label} contains a control byte in a string`);
      }
      if (!escaped && character === "\\") {
        escaped = true;
      } else {
        escaped = false;
      }
      this.offset += 1;
    }
    fail("INVALID_JSON", `${this.label} contains an unterminated string`);
  }

  private parseInteger(): bigint {
    const start = this.offset;
    if (this.text[this.offset] === "-") this.offset += 1;
    if (this.text[this.offset] === "0") {
      this.offset += 1;
      if (this.text[this.offset] >= "0" && this.text[this.offset] <= "9") {
        fail("JSON_NUMBER", `${this.label} integer has a leading zero`);
      }
    } else {
      const first = this.text[this.offset];
      if (first < "1" || first > "9") {
        fail("JSON_NUMBER", `${this.label} contains an invalid integer`);
      }
      while (this.text[this.offset] >= "0" && this.text[this.offset] <= "9") {
        this.offset += 1;
      }
    }
    const next = this.text[this.offset];
    if (next === "." || next === "e" || next === "E" || next === "+") {
      fail("JSON_NUMBER", `${this.label} permits exact integers only`);
    }
    const raw = this.text.slice(start, this.offset);
    let value: bigint;
    try {
      value = BigInt(raw);
    } catch {
      fail("JSON_NUMBER", `${this.label} contains an invalid integer`);
    }
    if (value < MIN_SIGNED_64 || value > MAX_SIGNED_64) {
      fail("JSON_NUMBER", `${this.label} integer exceeds signed-64 bounds`);
    }
    return value;
  }

  private take(value: string): boolean {
    if (!this.text.startsWith(value, this.offset)) return false;
    this.offset += value.length;
    return true;
  }
}

function parseCanonicalObject(
  bytes: Uint8Array,
  maximum: number,
  label: string
): { object: JsonObject; canonicalAscii: string } {
  if (!(bytes instanceof Uint8Array)) fail("RAW_TYPE", `${label} must be exact bytes`);
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) {
    fail("RAW_SIZE", `${label} exceeds its encoded byte bound`);
  }
  if ([...bytes].some((byte) => byte > 0x7f)) {
    fail("INVALID_ASCII", `${label} must be ASCII JSON`);
  }
  const canonicalAscii = Buffer.from(bytes).toString("ascii");
  const object = new CanonicalJsonParser(canonicalAscii, label).parseObjectRoot();
  return { object, canonicalAscii };
}

function exactObject(
  value: JsonValue,
  expected: readonly string[],
  label: string
): JsonObject {
  if (!isObject(value)) fail("FIELD_TYPE", `${label} must be an exact object`);
  const present = Object.keys(value);
  if (
    present.length !== expected.length ||
    expected.some((field) => !Object.prototype.hasOwnProperty.call(value, field))
  ) {
    fail("FIELD_SET", `${label} fields differ from the frozen contract`);
  }
  return value;
}

function exactString(value: JsonValue, label: string): string {
  if (typeof value !== "string") fail("FIELD_TYPE", `${label} must be a string`);
  return value;
}

function literal(value: JsonValue, expected: string, label: string): string {
  const actual = exactString(value, label);
  if (actual !== expected) fail("FIELD_VALUE", `${label} has an unsupported literal`);
  return actual;
}

function stableId(value: JsonValue, label: string): string {
  const actual = exactString(value, label);
  if (!STABLE_ID.test(actual)) fail("FIELD_VALUE", `${label} must be an ASCII stable ID`);
  return actual;
}

function domainId(value: JsonValue, label: string): string {
  const actual = exactString(value, label);
  if (
    actual.length < 1 ||
    actual.length > 128 ||
    [...actual].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x21 || code > 0x7e;
    })
  ) {
    fail("FIELD_VALUE", `${label} must be bounded printable non-whitespace ASCII`);
  }
  return actual;
}

function messageId(value: JsonValue): string {
  const actual = exactString(value, "message_id");
  if (
    actual.length < 1 ||
    actual.length > 192 ||
    [...actual].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x21 || code > 0x7e;
    })
  ) {
    fail("FIELD_VALUE", "message_id must be bounded printable ASCII");
  }
  return actual;
}

function exactInteger(
  value: JsonValue,
  label: string,
  minimum = BigInt(0),
  maximum = MAX_SIGNED_64
): bigint {
  if (typeof value !== "bigint") fail("FIELD_TYPE", `${label} must be an exact integer`);
  if (value < minimum || value > maximum) {
    fail("FIELD_BOUNDS", `${label} is outside its signed-64 bound`);
  }
  return value;
}

function fingerprint(value: JsonValue, label: string): string {
  const actual = exactString(value, label);
  if (!SHA256.test(actual)) fail("FIELD_VALUE", `${label} must be a lowercase SHA-256`);
  return actual;
}

function nullableFingerprint(value: JsonValue, label: string): string | null {
  return value === null ? null : fingerprint(value, label);
}

function printableText(value: JsonValue, label: string, maximum: number): string {
  const actual = exactString(value, label);
  if (
    actual.length < 1 ||
    actual.length > maximum ||
    actual.trim() !== actual ||
    [...actual].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code > 0x7e;
    })
  ) {
    fail("FIELD_VALUE", `${label} must be bounded printable ASCII`);
  }
  return actual;
}

function nullableLiteral(value: JsonValue, allowed: readonly string[], label: string): string | null {
  if (value === null) return null;
  const actual = exactString(value, label);
  if (!allowed.includes(actual)) fail("FIELD_VALUE", `${label} has an unsupported value`);
  return actual;
}

function canonicalBase64(
  value: JsonValue,
  label: string,
  options: { exactBytes?: number; maximumBytes?: number } = {}
): Buffer {
  const text = exactString(value, label);
  if (!text || !CANONICAL_BASE64.test(text)) {
    fail("FIELD_VALUE", `${label} must be canonical base64`);
  }
  const raw = Buffer.from(text, "base64");
  if (raw.toString("base64") !== text) fail("FIELD_VALUE", `${label} must be canonical base64`);
  if (options.exactBytes !== undefined && raw.byteLength !== options.exactBytes) {
    fail("FIELD_BOUNDS", `${label} has the wrong decoded length`);
  }
  if (
    options.maximumBytes !== undefined &&
    (raw.byteLength < 1 || raw.byteLength > options.maximumBytes)
  ) {
    fail("FIELD_BOUNDS", `${label} exceeds its decoded byte bound`);
  }
  return raw;
}

const PAYLOAD_FIELDS = [
  "adopted_archive_fingerprint",
  "appended_at_ns",
  "authorization_record_fingerprint",
  "envelope_fingerprint",
  "event_fingerprint",
  "event_id",
  "event_summary",
  "match_id",
  "message_id",
  "official_scorecheck_mutation_permitted",
  "outbox_id",
  "post_state_summary",
  "reducer_build_sha256",
  "revision",
  "ruleset_fingerprint",
  "ruleset_id",
  "ruleset_version",
  "review_authorization_context_fingerprint",
  "review_history_head_sha256",
  "review_position",
  "schema_version",
  "scorer_copilot_case_fingerprint",
  "scorer_copilot_case_link_fingerprint",
  "scorer_copilot_signed_case_fingerprint",
  "state_fingerprint",
  "target",
  "topic"
] as const;

const EVENT_SUMMARY_FIELDS = [
  "domain_fields",
  "evidence_count",
  "evidence_refs_fingerprint",
  "event_type",
  "outcome",
  "replay_reason"
] as const;
const POST_STATE_FIELDS = [
  "current_set",
  "last_completed_set",
  "match_winner",
  "team_a_sets",
  "team_b_sets"
] as const;
const CURRENT_SET_FIELDS = [
  "number",
  "phase",
  "serving_player",
  "serving_team",
  "team_a_points",
  "team_b_points"
] as const;
const COMPLETED_SET_FIELDS = ["number", "team_a_points", "team_b_points", "winner"] as const;
const DISPATCH_FIELDS = [
  "algorithm",
  "attempt_id",
  "dispatcher_id",
  "dispatcher_key_id",
  "expires_at_ns",
  "message_id",
  "outbox_id",
  "payload_base64",
  "payload_sha256",
  "schema_version",
  "signature_base64",
  "signed_at_ns",
  "source_ledger_id"
] as const;

export type VisionEventType =
  | "SET_SEED"
  | "POINT_AWARDED"
  | "REPLAY_NO_POINT"
  | "SIDE_SWITCH_CONFIRMED"
  | "TECHNICAL_TIMEOUT_COMPLETED";

export interface VisionCurrentSetSummary {
  readonly number: string;
  readonly phase: "IN_PROGRESS" | "COMPLETE";
  readonly servingPlayer: string;
  readonly servingTeam: "A" | "B";
  readonly teamAPoints: string;
  readonly teamBPoints: string;
}

export interface VisionCompletedSetSummary {
  readonly number: string;
  readonly teamAPoints: string;
  readonly teamBPoints: string;
  readonly winner: "A" | "B";
}

export interface VisionPostStateSummary {
  readonly currentSet: VisionCurrentSetSummary | null;
  readonly lastCompletedSet: VisionCompletedSetSummary | null;
  readonly matchWinner: "A" | "B" | null;
  readonly teamASets: string;
  readonly teamBSets: string;
}

export interface VisionEventSummary {
  readonly eventType: VisionEventType;
  readonly evidenceCount: string;
  readonly evidenceRefsFingerprint: string;
  readonly outcome: string | null;
  readonly replayReason: string | null;
}

export interface ValidatedVisionOutboxPayload {
  readonly canonicalAscii: string;
  readonly payloadSha256: string;
  readonly messageId: string;
  readonly outboxId: string;
  readonly sourceMatchId: string;
  readonly sourceRevision: string;
  readonly sourceEventId: string;
  readonly appendedAtNs: string;
  readonly eventSummary: VisionEventSummary;
  readonly eventSummaryDecimalJson: string;
  readonly postStateSummary: VisionPostStateSummary;
  readonly postStateSummaryDecimalJson: string;
  readonly rulesetId: string;
  readonly rulesetVersion: string;
  readonly rulesetFingerprint: string;
  readonly reducerBuildSha256: string;
  readonly adoptedArchiveFingerprint: string;
  readonly authorizationRecordFingerprint: string;
  readonly envelopeFingerprint: string;
  readonly eventFingerprint: string;
  readonly stateFingerprint: string;
  readonly reviewHistoryHeadSha256: string;
  readonly reviewPosition: string;
  readonly scorerCopilotCaseFingerprint: string | null;
  readonly scorerCopilotSignedCaseFingerprint: string | null;
  readonly scorerCopilotCaseLinkFingerprint: string | null;
  readonly reviewAuthorizationContextFingerprint: string | null;
}

function validateSetSeed(summary: JsonObject, domain: JsonObject): void {
  exactObject(
    domain,
    ["service_order_a", "service_order_b", "serving_player", "serving_team", "side_a", "side_b"],
    "event_summary.domain_fields"
  );
  const orders: string[] = [];
  for (const field of ["service_order_a", "service_order_b"] as const) {
    const order = domain[field];
    if (!Array.isArray(order) || order.length !== 2) {
      fail("FIELD_TYPE", `domain_fields.${field} must be a two-item array`);
    }
    const players = order.map((player) => domainId(player, `domain_fields.${field}`));
    if (new Set(players).size !== 2) fail("FIELD_VALUE", `${field} players must be distinct`);
    orders.push(...players);
  }
  if (new Set(orders).size !== 4) fail("FIELD_VALUE", "set-seed player identities must be distinct");
  const servingTeam = literalOneOf(domain.serving_team, ["A", "B"], "domain_fields.serving_team");
  const servingPlayer = domainId(domain.serving_player, "domain_fields.serving_player");
  if (servingPlayer !== (servingTeam === "A" ? orders[0] : orders[2])) {
    fail("FIELD_VALUE", "serving_player must lead the serving team's order");
  }
  const sideA = literalOneOf(domain.side_a, ["NEAR", "FAR"], "domain_fields.side_a");
  const sideB = literalOneOf(domain.side_b, ["NEAR", "FAR"], "domain_fields.side_b");
  if (sideA === sideB) fail("FIELD_VALUE", "set-seed teams must occupy opposite sides");
  if (summary.evidence_count !== BigInt(0)) fail("FIELD_VALUE", "SET_SEED must have no evidence");
  const emptyEvidence = sha256Bytes(Buffer.concat([EVIDENCE_SET_DOMAIN, Buffer.from("[]", "ascii")]));
  if (summary.evidence_refs_fingerprint !== emptyEvidence) {
    fail("FIELD_VALUE", "SET_SEED must bind the empty evidence set");
  }
  if (summary.outcome !== null || summary.replay_reason !== null) {
    fail("FIELD_VALUE", "SET_SEED cannot claim a rally outcome");
  }
}

function literalOneOf<T extends string>(value: JsonValue, allowed: readonly T[], label: string): T {
  const actual = exactString(value, label);
  if (!allowed.includes(actual as T)) fail("FIELD_VALUE", `${label} has an unsupported value`);
  return actual as T;
}

function validateEventSummary(value: JsonValue): VisionEventSummary {
  const summary = exactObject(value, EVENT_SUMMARY_FIELDS, "event_summary");
  const evidenceCount = exactInteger(
    summary.evidence_count,
    "event_summary.evidence_count",
    BigInt(0),
    MAX_EVIDENCE_COUNT
  );
  const evidenceRefsFingerprint = fingerprint(
    summary.evidence_refs_fingerprint,
    "event_summary.evidence_refs_fingerprint"
  );
  const eventType = exactString(summary.event_type, "event_summary.event_type");
  const domain = exactObject(summary.domain_fields, Object.keys(summary.domain_fields ?? {}), "event_summary.domain_fields");

  if (eventType === "SET_SEED") {
    validateSetSeed(summary, domain);
  } else if (eventType === "POINT_AWARDED") {
    exactObject(domain, ["winner_team"], "event_summary.domain_fields");
    const winner = literalOneOf(domain.winner_team, ["A", "B"], "domain_fields.winner_team");
    if (evidenceCount < BigInt(1)) fail("FIELD_VALUE", "POINT_AWARDED requires evidence");
    if (summary.outcome !== `POINT_TEAM_${winner}` || summary.replay_reason !== null) {
      fail("FIELD_VALUE", "point outcome is inconsistent");
    }
  } else if (eventType === "REPLAY_NO_POINT") {
    exactObject(domain, ["reason"], "event_summary.domain_fields");
    const reason = printableText(domain.reason, "domain_fields.reason", 512);
    if (evidenceCount < BigInt(1)) fail("FIELD_VALUE", "REPLAY_NO_POINT requires evidence");
    if (summary.outcome !== "REPLAY_NO_POINT" || summary.replay_reason !== reason) {
      fail("FIELD_VALUE", "replay outcome is inconsistent");
    }
  } else if (eventType === "SIDE_SWITCH_CONFIRMED") {
    exactObject(
      domain,
      ["cleared_through_total", "due_total", "observed_at_total", "observed_side_a", "observed_side_b"],
      "event_summary.domain_fields"
    );
    for (const field of ["cleared_through_total", "due_total", "observed_at_total"] as const) {
      exactInteger(domain[field], `domain_fields.${field}`);
    }
    const sideA = literalOneOf(domain.observed_side_a, ["NEAR", "FAR"], "domain_fields.observed_side_a");
    const sideB = literalOneOf(domain.observed_side_b, ["NEAR", "FAR"], "domain_fields.observed_side_b");
    if (sideA === sideB) fail("FIELD_VALUE", "observed teams must occupy opposite sides");
    if (evidenceCount < BigInt(1)) fail("FIELD_VALUE", "SIDE_SWITCH_CONFIRMED requires evidence");
    if (summary.outcome !== null || summary.replay_reason !== null) {
      fail("FIELD_VALUE", "side-switch event cannot claim a rally outcome");
    }
  } else if (eventType === "TECHNICAL_TIMEOUT_COMPLETED") {
    exactObject(domain, ["due_total", "observed_at_total"], "event_summary.domain_fields");
    exactInteger(domain.due_total, "domain_fields.due_total");
    exactInteger(domain.observed_at_total, "domain_fields.observed_at_total");
    if (evidenceCount < BigInt(1)) fail("FIELD_VALUE", "timeout event requires evidence");
    if (summary.outcome !== null || summary.replay_reason !== null) {
      fail("FIELD_VALUE", "timeout event cannot claim a rally outcome");
    }
  } else {
    fail("UNSUPPORTED_EVENT_TYPE", "event_summary.event_type is unsupported");
  }

  return Object.freeze({
    eventType: eventType as VisionEventType,
    evidenceCount: evidenceCount.toString(10),
    evidenceRefsFingerprint,
    outcome: summary.outcome === null ? null : exactString(summary.outcome, "event_summary.outcome"),
    replayReason:
      summary.replay_reason === null
        ? null
        : exactString(summary.replay_reason, "event_summary.replay_reason")
  });
}

function validatePostState(value: JsonValue): VisionPostStateSummary {
  const state = exactObject(value, POST_STATE_FIELDS, "post_state_summary");
  const teamASets = exactInteger(state.team_a_sets, "post_state_summary.team_a_sets").toString(10);
  const teamBSets = exactInteger(state.team_b_sets, "post_state_summary.team_b_sets").toString(10);
  const matchWinner = nullableLiteral(state.match_winner, ["A", "B"], "post_state_summary.match_winner") as
    | "A"
    | "B"
    | null;

  let currentSet: VisionCurrentSetSummary | null = null;
  if (state.current_set !== null) {
    const current = exactObject(state.current_set, CURRENT_SET_FIELDS, "post_state_summary.current_set");
    currentSet = Object.freeze({
      number: exactInteger(current.number, "current_set.number", BigInt(1), BigInt(99)).toString(10),
      phase: literalOneOf(current.phase, ["IN_PROGRESS", "COMPLETE"], "current_set.phase"),
      servingPlayer: domainId(current.serving_player, "current_set.serving_player"),
      servingTeam: literalOneOf(current.serving_team, ["A", "B"], "current_set.serving_team"),
      teamAPoints: exactInteger(current.team_a_points, "current_set.team_a_points").toString(10),
      teamBPoints: exactInteger(current.team_b_points, "current_set.team_b_points").toString(10)
    });
  }

  let lastCompletedSet: VisionCompletedSetSummary | null = null;
  if (state.last_completed_set !== null) {
    const completed = exactObject(
      state.last_completed_set,
      COMPLETED_SET_FIELDS,
      "post_state_summary.last_completed_set"
    );
    lastCompletedSet = Object.freeze({
      number: exactInteger(completed.number, "last_completed_set.number", BigInt(1), BigInt(99)).toString(10),
      teamAPoints: exactInteger(completed.team_a_points, "last_completed_set.team_a_points").toString(10),
      teamBPoints: exactInteger(completed.team_b_points, "last_completed_set.team_b_points").toString(10),
      winner: literalOneOf(completed.winner, ["A", "B"], "last_completed_set.winner")
    });
  }

  return Object.freeze({ currentSet, lastCompletedSet, matchWinner, teamASets, teamBSets });
}

export function parseVisionOutboxPayload(bytes: Uint8Array): ValidatedVisionOutboxPayload {
  const parsed = parseCanonicalObject(bytes, MAX_VISION_OUTBOX_BYTES, "vision shadow payload");
  const data = exactObject(parsed.object, PAYLOAD_FIELDS, "vision shadow payload");
  literal(data.schema_version, VISION_OUTBOX_SCHEMA_VERSION, "schema_version");
  literal(data.topic, VISION_OUTBOX_TOPIC, "topic");
  literal(data.target, VISION_OUTBOX_TARGET, "target");
  if (typeof data.official_scorecheck_mutation_permitted !== "boolean") {
    fail("FIELD_TYPE", "official_scorecheck_mutation_permitted must be an exact bool");
  }
  if (data.official_scorecheck_mutation_permitted) {
    fail("MUTATION_FORBIDDEN", "vision payload must forbid official mutation");
  }

  const sourceMatchId = stableId(data.match_id, "match_id");
  const sourceEventId = domainId(data.event_id, "event_id");
  const rulesetId = domainId(data.ruleset_id, "ruleset_id");
  const rulesetVersion = domainId(data.ruleset_version, "ruleset_version");
  const parsedMessageId = messageId(data.message_id);
  const outboxId = exactInteger(data.outbox_id, "outbox_id", BigInt(1));
  const sourceRevision = exactInteger(data.revision, "revision", BigInt(1));
  const appendedAtNs = exactInteger(data.appended_at_ns, "appended_at_ns");
  const reviewPosition = exactInteger(
    data.review_position,
    "review_position",
    BigInt(0),
    MAX_REVIEW_POSITION
  );
  if (parsedMessageId !== `shadow:${outboxId.toString(10)}:${sourceEventId}`) {
    fail("IDENTITY_MISMATCH", "message_id does not bind outbox_id and event_id");
  }

  const scorerCopilotCaseFingerprint = nullableFingerprint(
    data.scorer_copilot_case_fingerprint,
    "scorer_copilot_case_fingerprint"
  );
  const scorerCopilotSignedCaseFingerprint = nullableFingerprint(
    data.scorer_copilot_signed_case_fingerprint,
    "scorer_copilot_signed_case_fingerprint"
  );
  const scorerCopilotCaseLinkFingerprint = nullableFingerprint(
    data.scorer_copilot_case_link_fingerprint,
    "scorer_copilot_case_link_fingerprint"
  );
  const reviewAuthorizationContextFingerprint = nullableFingerprint(
    data.review_authorization_context_fingerprint,
    "review_authorization_context_fingerprint"
  );
  const copilot = [
    scorerCopilotCaseFingerprint,
    scorerCopilotSignedCaseFingerprint,
    scorerCopilotCaseLinkFingerprint,
    reviewAuthorizationContextFingerprint
  ];
  if (copilot.some((value) => value === null) !== copilot.every((value) => value === null)) {
    fail("COPILOT_IDENTITY_SET", "copilot fingerprints must be all present or all absent");
  }

  const eventSummary = validateEventSummary(data.event_summary);
  const eventSummaryDecimalJson = canonicalJson(decimalStringJson(data.event_summary));
  if (
    scorerCopilotCaseFingerprint !== null &&
    (!(["POINT_AWARDED", "REPLAY_NO_POINT"] as VisionEventType[]).includes(eventSummary.eventType) ||
      reviewPosition < BigInt(1))
  ) {
    fail("COPILOT_EVENT_CORRELATION", "copilot identities require a linked point or replay");
  }

  return Object.freeze({
    canonicalAscii: parsed.canonicalAscii,
    payloadSha256: sha256Bytes(Buffer.from(parsed.canonicalAscii, "ascii")),
    messageId: parsedMessageId,
    outboxId: outboxId.toString(10),
    sourceMatchId,
    sourceRevision: sourceRevision.toString(10),
    sourceEventId,
    appendedAtNs: appendedAtNs.toString(10),
    eventSummary,
    eventSummaryDecimalJson,
    postStateSummary: validatePostState(data.post_state_summary),
    postStateSummaryDecimalJson: canonicalJson(decimalStringJson(data.post_state_summary)),
    rulesetId,
    rulesetVersion,
    rulesetFingerprint: fingerprint(data.ruleset_fingerprint, "ruleset_fingerprint"),
    reducerBuildSha256: fingerprint(data.reducer_build_sha256, "reducer_build_sha256"),
    adoptedArchiveFingerprint: fingerprint(
      data.adopted_archive_fingerprint,
      "adopted_archive_fingerprint"
    ),
    authorizationRecordFingerprint: fingerprint(
      data.authorization_record_fingerprint,
      "authorization_record_fingerprint"
    ),
    envelopeFingerprint: fingerprint(data.envelope_fingerprint, "envelope_fingerprint"),
    eventFingerprint: fingerprint(data.event_fingerprint, "event_fingerprint"),
    stateFingerprint: fingerprint(data.state_fingerprint, "state_fingerprint"),
    reviewHistoryHeadSha256: fingerprint(
      data.review_history_head_sha256,
      "review_history_head_sha256"
    ),
    reviewPosition: reviewPosition.toString(10),
    scorerCopilotCaseFingerprint,
    scorerCopilotSignedCaseFingerprint,
    scorerCopilotCaseLinkFingerprint,
    reviewAuthorizationContextFingerprint
  });
}

export interface ProtectedVisionDispatcherKey {
  readonly dispatcherId: string;
  readonly keyId: string;
  readonly publicKeyBase64: string;
  readonly validFromNs: string;
  readonly validUntilNs: string;
  readonly revokedAtNs: string | null;
}

export interface ProtectedVisionDispatcherRegistry {
  readonly sourceLedgerId: string;
  readonly currentKeyId: string;
  readonly keys: readonly ProtectedVisionDispatcherKey[];
}

export interface VisionDispatchTrustPolicy {
  readonly registry: ProtectedVisionDispatcherRegistry;
  readonly maximumClockSkewNs: string;
  readonly maximumEnvelopeLifetimeNs: string;
}

export interface VerifiedVisionDispatch {
  readonly sourceLedgerId: string;
  readonly dispatcherId: string;
  readonly dispatcherKeyId: string;
  readonly attemptId: string;
  readonly signedAtNs: string;
  readonly expiresAtNs: string;
  readonly envelopeCanonicalAscii: string;
  readonly envelopeSha256: string;
  readonly payload: ValidatedVisionOutboxPayload;
}

function protectedNanoseconds(value: string, label: string, minimum = BigInt(0)): bigint {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    fail("TRUST_POLICY", `${label} must be a canonical non-negative signed-64 decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > MAX_SIGNED_64) {
    fail("TRUST_POLICY", `${label} is outside its signed-64 bound`);
  }
  return parsed;
}

function validateRegistry(policy: VisionDispatchTrustPolicy): {
  skew: bigint;
  lifetime: bigint;
  keys: ReadonlyArray<ProtectedVisionDispatcherKey & { from: bigint; until: bigint; revoked: bigint | null }>;
} {
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    Object.keys(policy).sort().join(",") !==
      "maximumClockSkewNs,maximumEnvelopeLifetimeNs,registry" ||
    !policy.registry
  ) {
    fail("TRUST_POLICY", "dispatcher trust policy is required");
  }
  const registry = policy.registry;
  if (
    typeof registry !== "object" ||
    Array.isArray(registry) ||
    Object.keys(registry).sort().join(",") !== "currentKeyId,keys,sourceLedgerId"
  ) {
    fail("KEY_REGISTRY", "registry fields differ from the protected contract");
  }
  if (!STABLE_ID.test(registry.sourceLedgerId) || !STABLE_ID.test(registry.currentKeyId)) {
    fail("KEY_REGISTRY", "registry identities must be stable IDs");
  }
  if (!Array.isArray(registry.keys) || registry.keys.length < 1 || registry.keys.length > MAX_VISION_DISPATCH_KEYS) {
    fail("KEY_REGISTRY", "registry must contain 1..64 keys");
  }
  const seenIdentity = new Set<string>();
  const seenKey = new Set<string>();
  const seenPublic = new Set<string>();
  const keys = registry.keys.map((key) => {
    if (
      !key ||
      typeof key !== "object" ||
      Array.isArray(key) ||
      Object.keys(key).sort().join(",") !==
        "dispatcherId,keyId,publicKeyBase64,revokedAtNs,validFromNs,validUntilNs"
    ) {
      fail("KEY_REGISTRY", "dispatcher key fields differ from the protected contract");
    }
    if (!STABLE_ID.test(key.dispatcherId) || !STABLE_ID.test(key.keyId)) {
      fail("KEY_REGISTRY", "dispatcher identities must be stable IDs");
    }
    const publicKey = canonicalBase64(key.publicKeyBase64, "publicKeyBase64", { exactBytes: 32 });
    const from = protectedNanoseconds(key.validFromNs, "validFromNs");
    const until = protectedNanoseconds(key.validUntilNs, "validUntilNs");
    const revoked = key.revokedAtNs === null ? null : protectedNanoseconds(key.revokedAtNs, "revokedAtNs");
    if (until < from) fail("KEY_TIME", "dispatcher key validity interval is reversed");
    const identity = `${key.dispatcherId}\u0000${key.keyId}`;
    if (seenIdentity.has(identity) || seenKey.has(key.keyId) || seenPublic.has(publicKey.toString("base64"))) {
      fail("KEY_REGISTRY", "dispatcher registry identities and key bytes must be unique");
    }
    seenIdentity.add(identity);
    seenKey.add(key.keyId);
    seenPublic.add(publicKey.toString("base64"));
    return { ...key, from, until, revoked };
  });
  if (keys.filter((key) => key.keyId === registry.currentKeyId).length !== 1) {
    fail("KEY_REGISTRY", "currentKeyId must select exactly one retained key");
  }
  return {
    skew: protectedNanoseconds(policy.maximumClockSkewNs, "maximumClockSkewNs"),
    lifetime: protectedNanoseconds(policy.maximumEnvelopeLifetimeNs, "maximumEnvelopeLifetimeNs", BigInt(1)),
    keys
  };
}

export function verifyVisionShadowDispatch(
  envelopeBytes: Uint8Array,
  policy: VisionDispatchTrustPolicy,
  verifiedAtNs: string
): VerifiedVisionDispatch {
  const parsed = parseCanonicalObject(envelopeBytes, MAX_VISION_DISPATCH_BYTES, "vision dispatch envelope");
  const envelope = exactObject(parsed.object, DISPATCH_FIELDS, "vision dispatch envelope");
  literal(envelope.schema_version, VISION_DISPATCH_SCHEMA_VERSION, "schema_version");
  literal(envelope.algorithm, VISION_DISPATCH_ALGORITHM, "algorithm");
  const sourceLedgerId = stableId(envelope.source_ledger_id, "source_ledger_id");
  const dispatcherId = stableId(envelope.dispatcher_id, "dispatcher_id");
  const dispatcherKeyId = stableId(envelope.dispatcher_key_id, "dispatcher_key_id");
  const attemptId = stableId(envelope.attempt_id, "attempt_id");
  const signedAt = exactInteger(envelope.signed_at_ns, "signed_at_ns");
  const expiresAt = exactInteger(envelope.expires_at_ns, "expires_at_ns");
  if (expiresAt < signedAt) fail("DISPATCH_TIME", "dispatch expiry predates signing");

  const payloadBytes = canonicalBase64(envelope.payload_base64, "payload_base64", {
    maximumBytes: MAX_VISION_OUTBOX_BYTES
  });
  const payload = parseVisionOutboxPayload(payloadBytes);
  const payloadSha256 = fingerprint(envelope.payload_sha256, "payload_sha256");
  if (payload.payloadSha256 !== payloadSha256) fail("PAYLOAD_HASH", "payload SHA-256 does not bind bytes");
  if (
    messageId(envelope.message_id) !== payload.messageId ||
    exactInteger(envelope.outbox_id, "outbox_id", BigInt(1)).toString(10) !== payload.outboxId
  ) {
    fail("IDENTITY_MISMATCH", "dispatch identities do not bind the exact payload");
  }
  const signature = canonicalBase64(envelope.signature_base64, "signature_base64", { exactBytes: 64 });

  const protectedPolicy = validateRegistry(policy);
  const verifiedAt = protectedNanoseconds(verifiedAtNs, "verifiedAtNs");
  if (sourceLedgerId !== policy.registry.sourceLedgerId) {
    fail("SOURCE_LEDGER_MISMATCH", "dispatch source ledger is not trusted");
  }
  const matches = protectedPolicy.keys.filter(
    (key) => key.keyId === dispatcherKeyId && key.dispatcherId === dispatcherId
  );
  if (matches.length !== 1) fail("KEY_UNTRUSTED", "dispatcher identity/key is not retained exactly once");
  const key = matches[0];
  if (key.keyId !== policy.registry.currentKeyId) fail("KEY_NOT_CURRENT", "dispatcher key is not current");
  if (expiresAt - signedAt > protectedPolicy.lifetime) {
    fail("DISPATCH_LIFETIME", "dispatch lifetime exceeds protected policy");
  }
  if (signedAt > verifiedAt + protectedPolicy.skew) {
    fail("DISPATCH_FUTURE", "dispatch signing time exceeds allowed clock skew");
  }
  if (verifiedAt > expiresAt + protectedPolicy.skew) {
    fail("DISPATCH_EXPIRED", "dispatch expired beyond allowed clock skew");
  }
  if (!(key.from <= signedAt && signedAt <= expiresAt && expiresAt <= key.until)) {
    fail("KEY_INACTIVE", "dispatcher key is inactive for the envelope lifetime");
  }
  const laterBoundary = expiresAt > verifiedAt ? expiresAt : verifiedAt;
  if (key.revoked !== null && key.revoked <= laterBoundary) {
    fail("KEY_REVOKED", "dispatcher revocation intersects envelope lifetime or verification time");
  }

  const unsigned: JsonObject = { ...envelope };
  delete unsigned.signature_base64;
  const signingMessage = Buffer.concat([
    DISPATCH_SIGNING_DOMAIN,
    Buffer.from(canonicalJson(unsigned), "ascii")
  ]);
  const publicKeyRaw = canonicalBase64(key.publicKeyBase64, "publicKeyBase64", { exactBytes: 32 });
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]),
    format: "der",
    type: "spki"
  });
  if (!verifyEd25519(null, signingMessage, publicKey, signature)) {
    fail("SIGNATURE_INVALID", "vision dispatch signature is invalid");
  }

  return Object.freeze({
    sourceLedgerId,
    dispatcherId,
    dispatcherKeyId,
    attemptId,
    signedAtNs: signedAt.toString(10),
    expiresAtNs: expiresAt.toString(10),
    envelopeCanonicalAscii: parsed.canonicalAscii,
    envelopeSha256: sha256Bytes(Buffer.from(parsed.canonicalAscii, "ascii")),
    payload
  });
}

export const visionShadowInternalsForTests = Object.freeze({
  canonicalJson,
  dispatchSigningDomain: DISPATCH_SIGNING_DOMAIN.toString("ascii")
});
