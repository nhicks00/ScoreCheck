import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signEd25519
} from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fixedVisionReceiptPersistence,
  ingestVisionShadowDispatch,
  parseVisionOutboxPayload,
  readVerifiedVisionShadowProjection,
  verifyVisionShadowDispatch,
  VisionShadowError,
  type AuthenticatedVisionReceiptCommand,
  type ProtectedVisionDispatcherRegistry,
  type VisionDispatchTrustPolicy,
  type VisionHistoricalTrustResolver,
  type VisionShadowProjection,
  type VisionShadowReceiptPersistence
} from "../lib/vision-shadow";

type CanonicalValue =
  | string
  | bigint
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

const SIGNING_DOMAIN = Buffer.from(
  "multicourt-vision-scoring:shadow-dispatch-envelope:v1\u0000",
  "ascii"
);
const EVIDENCE_DOMAIN = Buffer.from(
  "multicourt-vision-scoring:outbox-evidence-set:v1\u0000",
  "ascii"
);
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const FIXED_SEED = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex"
);
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, FIXED_SEED]),
  format: "der",
  type: "pkcs8"
});
const PUBLIC_DER = createPublicKey(PRIVATE_KEY).export({ format: "der", type: "spki" }) as Buffer;
const PUBLIC_KEY_BASE64 = PUBLIC_DER.subarray(PUBLIC_DER.byteLength - 32).toString("base64");
const BASE_TIME = BigInt("1700000000000000000");
const HASH = "a".repeat(64);

function canonical(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface PayloadOptions {
  readonly revision?: bigint;
  readonly outboxId?: bigint;
  readonly eventId?: string;
  readonly eventType?:
    | "SET_SEED"
    | "POINT_AWARDED"
    | "REPLAY_NO_POINT"
    | "SIDE_SWITCH_CONFIRMED"
    | "TECHNICAL_TIMEOUT_COMPLETED";
  readonly reducerBuildSha256?: string;
  readonly sourceMatchId?: string;
  readonly extra?: Record<string, CanonicalValue>;
  readonly mutationPermitted?: boolean;
}

function payloadObject(options: PayloadOptions = {}): Record<string, CanonicalValue> {
  const revision = options.revision ?? BigInt(1);
  const outboxId = options.outboxId ?? revision;
  const eventId = options.eventId ?? (revision === BigInt(1) ? "event+seed" : `event+${revision}`);
  const eventType = options.eventType ?? (revision === BigInt(1) ? "SET_SEED" : "POINT_AWARDED");
  const emptyEvidenceFingerprint = sha256(Buffer.concat([EVIDENCE_DOMAIN, Buffer.from("[]", "ascii")]));
  let eventSummary: Record<string, CanonicalValue>;
  if (eventType === "SET_SEED") {
    eventSummary = {
          domain_fields: {
            service_order_a: ["a+1", "a2"],
            service_order_b: ["b1", "b2"],
            serving_player: "a+1",
            serving_team: "A",
            side_a: "NEAR",
            side_b: "FAR"
          },
          evidence_count: BigInt(0),
          evidence_refs_fingerprint: emptyEvidenceFingerprint,
          event_type: "SET_SEED",
          outcome: null,
          replay_reason: null
        };
  } else if (eventType === "POINT_AWARDED") {
    eventSummary = {
          domain_fields: { winner_team: "A" },
          evidence_count: BigInt(1),
          evidence_refs_fingerprint: "b".repeat(64),
          event_type: "POINT_AWARDED",
          outcome: "POINT_TEAM_A",
          replay_reason: null
        };
  } else if (eventType === "REPLAY_NO_POINT") {
    eventSummary = {
      domain_fields: { reason: "camera occlusion" },
      evidence_count: BigInt(1),
      evidence_refs_fingerprint: "b".repeat(64),
      event_type: eventType,
      outcome: "REPLAY_NO_POINT",
      replay_reason: "camera occlusion"
    };
  } else if (eventType === "SIDE_SWITCH_CONFIRMED") {
    eventSummary = {
      domain_fields: {
        cleared_through_total: BigInt(7),
        due_total: BigInt(7),
        observed_at_total: BigInt(7),
        observed_side_a: "FAR",
        observed_side_b: "NEAR"
      },
      evidence_count: BigInt(1),
      evidence_refs_fingerprint: "b".repeat(64),
      event_type: eventType,
      outcome: null,
      replay_reason: null
    };
  } else {
    eventSummary = {
      domain_fields: { due_total: BigInt(21), observed_at_total: BigInt(21) },
      evidence_count: BigInt(1),
      evidence_refs_fingerprint: "b".repeat(64),
      event_type: eventType,
      outcome: null,
      replay_reason: null
    };
  }
  return {
    adopted_archive_fingerprint: HASH,
    appended_at_ns: BASE_TIME + revision,
    authorization_record_fingerprint: "b".repeat(64),
    envelope_fingerprint: "c".repeat(64),
    event_fingerprint: "d".repeat(64),
    event_id: eventId,
    event_summary: eventSummary,
    match_id: options.sourceMatchId ?? "vision-match-1",
    message_id: `shadow:${outboxId}:${eventId}`,
    official_scorecheck_mutation_permitted: options.mutationPermitted ?? false,
    outbox_id: outboxId,
    post_state_summary: {
      current_set: {
        number: BigInt(1),
        phase: "IN_PROGRESS",
        serving_player: "a+1",
        serving_team: "A",
        team_a_points: eventType === "SET_SEED" ? BigInt(0) : revision - BigInt(1),
        team_b_points: BigInt(0)
      },
      last_completed_set: null,
      match_winner: null,
      team_a_sets: BigInt(0),
      team_b_sets: BigInt(0)
    },
    reducer_build_sha256: options.reducerBuildSha256 ?? "e".repeat(64),
    revision,
    ruleset_fingerprint: "f".repeat(64),
    ruleset_id: "beach+rules",
    ruleset_version: "v1+hardcut",
    review_authorization_context_fingerprint: null,
    review_history_head_sha256: "1".repeat(64),
    review_position: BigInt(0),
    schema_version: "2.0",
    scorer_copilot_case_fingerprint: null,
    scorer_copilot_case_link_fingerprint: null,
    scorer_copilot_signed_case_fingerprint: null,
    state_fingerprint: "2".repeat(64),
    target: "SHADOW_ONLY_NO_OFFICIAL_SCORECHECK_MUTATION",
    topic: "vision_scoring.shadow.authorized_event.v2",
    ...options.extra
  };
}

function makePayload(options: PayloadOptions = {}): string {
  return canonical(payloadObject(options));
}

interface DispatchOptions {
  readonly sourceLedgerId?: string;
  readonly signedAt?: bigint;
  readonly expiresAt?: bigint;
  readonly attemptId?: string;
  readonly extra?: Record<string, CanonicalValue>;
  readonly corruptSignature?: boolean;
}

function makeDispatch(payloadAscii = makePayload(), options: DispatchOptions = {}) {
  const payload = parseVisionOutboxPayload(Buffer.from(payloadAscii, "ascii"));
  const signedAt = options.signedAt ?? BASE_TIME + BigInt(100);
  const expiresAt = options.expiresAt ?? signedAt + BigInt(100);
  const unsigned: Record<string, CanonicalValue> = {
    algorithm: "Ed25519",
    attempt_id: options.attemptId ?? "attempt-1",
    dispatcher_id: "dispatcher-1",
    dispatcher_key_id: "dispatch-key-1",
    expires_at_ns: expiresAt,
    message_id: payload.messageId,
    outbox_id: BigInt(payload.outboxId),
    payload_base64: Buffer.from(payloadAscii, "ascii").toString("base64"),
    payload_sha256: payload.payloadSha256,
    schema_version: "1.0",
    signed_at_ns: signedAt,
    source_ledger_id: options.sourceLedgerId ?? "ledger-1",
    ...options.extra
  };
  const signature = signEd25519(
    null,
    Buffer.concat([SIGNING_DOMAIN, Buffer.from(canonical(unsigned), "ascii")]),
    PRIVATE_KEY
  );
  if (options.corruptSignature) signature[0] ^= 1;
  const envelopeAscii = canonical({ ...unsigned, signature_base64: signature.toString("base64") });
  return { envelopeAscii, payloadAscii, signedAt, expiresAt };
}

function policyFor(
  dispatch: ReturnType<typeof makeDispatch>,
  changes: Partial<ProtectedVisionDispatcherRegistry> & { revokedAtNs?: string | null } = {}
): VisionDispatchTrustPolicy {
  return {
    registry: {
      sourceLedgerId: changes.sourceLedgerId ?? "ledger-1",
      currentKeyId: changes.currentKeyId ?? "dispatch-key-1",
      keys:
        changes.keys ??
        [
          {
            dispatcherId: "dispatcher-1",
            keyId: "dispatch-key-1",
            publicKeyBase64: PUBLIC_KEY_BASE64,
            validFromNs: (dispatch.signedAt - BigInt(1000)).toString(10),
            validUntilNs: (dispatch.expiresAt + BigInt(1000)).toString(10),
            revokedAtNs: changes.revokedAtNs ?? null
          }
        ]
    },
    maximumClockSkewNs: "10",
    maximumEnvelopeLifetimeNs: "1000"
  };
}

function errorCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof VisionShadowError ? error.code : `unexpected:${String(error)}`;
  }
}

describe("vision shadow transport", () => {
  it("accepts exact canonical bytes emitted by the committed Python outbox-v2 producer", () => {
    const producerBytes = Buffer.from(
      '{"adopted_archive_fingerprint":"93bbfff1e1587657b554172056733f0664866bc7b134e24a70410b2a6a927364","appended_at_ns":140,"authorization_record_fingerprint":"4d007f3dfed3fc48b738801343660bd538a2e402f80420e18dd1ee167f329d3b","envelope_fingerprint":"f02bc6f6f67d0d2cbadfb26de7e39f7749ecd3ce79b48f409891751c7a64e82e","event_fingerprint":"6e9186e984801f575c9117db92a034e44769fe9667097d128f5b65ef0be93d1c","event_id":"event-match-1-1","event_summary":{"domain_fields":{"service_order_a":["a1","a2"],"service_order_b":["b1","b2"],"serving_player":"a1","serving_team":"A","side_a":"NEAR","side_b":"FAR"},"event_type":"SET_SEED","evidence_count":0,"evidence_refs_fingerprint":"b5cfb05158ef52fd97f0d6b0fe155ddba1b5bbd685ab8da051d79b4f1ffde8c6","outcome":null,"replay_reason":null},"match_id":"match-1","message_id":"shadow:1:event-match-1-1","official_scorecheck_mutation_permitted":false,"outbox_id":1,"post_state_summary":{"current_set":{"number":1,"phase":"IN_PROGRESS","serving_player":"a1","serving_team":"A","team_a_points":0,"team_b_points":0},"last_completed_set":null,"match_winner":null,"team_a_sets":0,"team_b_sets":0},"reducer_build_sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","review_authorization_context_fingerprint":null,"review_history_head_sha256":"f5cd1a4420f746655978c794e6550e6c6eab4871152d1043944f6e50fc11271e","review_position":0,"revision":1,"ruleset_fingerprint":"d814e2e4762a756ecc4e3b57010c0c345aed18b016bff39791b52daf27f722b4","ruleset_id":"FIVB_BEACH","ruleset_version":"2025-2028","schema_version":"2.0","scorer_copilot_case_fingerprint":null,"scorer_copilot_case_link_fingerprint":null,"scorer_copilot_signed_case_fingerprint":null,"state_fingerprint":"35ddb32cc1692645e10e27502f15d2f72019236003e6099aa1c1790450181671","target":"SHADOW_ONLY_NO_OFFICIAL_SCORECHECK_MUTATION","topic":"vision_scoring.shadow.authorized_event.v2"}',
      "ascii"
    );
    const payload = parseVisionOutboxPayload(producerBytes);
    expect(payload).toMatchObject({
      outboxId: "1",
      sourceMatchId: "match-1",
      sourceEventId: "event-match-1-1",
      sourceRevision: "1"
    });
    const pythonUnsigned: Record<string, CanonicalValue> = {
      algorithm: "Ed25519",
      attempt_id: "python-golden-1",
      dispatcher_id: "dispatcher-1",
      dispatcher_key_id: "dispatch-key-1",
      expires_at_ns: BigInt(250),
      message_id: payload.messageId,
      outbox_id: BigInt(payload.outboxId),
      payload_base64: producerBytes.toString("base64"),
      payload_sha256: payload.payloadSha256,
      schema_version: "1.0",
      signed_at_ns: BigInt(200),
      source_ledger_id: "ledger-1"
    };
    const pythonEnvelope = canonical({
      ...pythonUnsigned,
      signature_base64:
        "CV9fN5VrrWgD1xaW24LCppWeRq4EFnLqAD+PxXxuMzUKV6atVnA4iXe5T5khRXLATV6aabDc0nuT+bLGo/ksCw=="
    });
    const verified = verifyVisionShadowDispatch(
      Buffer.from(pythonEnvelope, "ascii"),
      {
        registry: {
          sourceLedgerId: "ledger-1",
          currentKeyId: "dispatch-key-1",
          keys: [
            {
              dispatcherId: "dispatcher-1",
              keyId: "dispatch-key-1",
              publicKeyBase64: PUBLIC_KEY_BASE64,
              validFromNs: "100",
              validUntilNs: "1000",
              revokedAtNs: null
            }
          ]
        },
        maximumClockSkewNs: "10",
        maximumEnvelopeLifetimeNs: "100"
      },
      "220"
    );
    expect(verified.envelopeSha256).toBe(
      "f784c395ee889919bdcaf2732685f9517c122f1bf959cbea24f728677ffa8759"
    );
  });

  it("verifies the exact Ed25519 envelope and preserves nanoseconds beyond JS safe integers", () => {
    const dispatch = makeDispatch();
    const verified = verifyVisionShadowDispatch(
      Buffer.from(dispatch.envelopeAscii, "ascii"),
      policyFor(dispatch),
      (dispatch.signedAt + BigInt(50)).toString(10)
    );
    expect(verified.sourceLedgerId).toBe("ledger-1");
    expect(verified.payload.sourceEventId).toBe("event+seed");
    expect(verified.payload.appendedAtNs).toBe((BASE_TIME + BigInt(1)).toString(10));
    expect(verified.payload.payloadSha256).toBe(sha256(Buffer.from(dispatch.payloadAscii, "ascii")));
  });

  it("rejects mutation permission, unknown payload fields, and identity drift", () => {
    expect(errorCode(() => parseVisionOutboxPayload(Buffer.from(makePayload({ mutationPermitted: true })))))
      .toBe("MUTATION_FORBIDDEN");
    expect(errorCode(() => parseVisionOutboxPayload(Buffer.from(makePayload({ extra: { surprise: "no" } })))))
      .toBe("FIELD_SET");
    const drift = payloadObject();
    drift.message_id = "shadow:1:other-event";
    expect(errorCode(() => parseVisionOutboxPayload(Buffer.from(canonical(drift)))))
      .toBe("IDENTITY_MISMATCH");
  });

  it("validates every frozen event presentation and copilot correlation", () => {
    for (const eventType of [
      "POINT_AWARDED",
      "REPLAY_NO_POINT",
      "SIDE_SWITCH_CONFIRMED",
      "TECHNICAL_TIMEOUT_COMPLETED"
    ] as const) {
      expect(parseVisionOutboxPayload(Buffer.from(makePayload({
        revision: BigInt(2),
        eventId: `event-${eventType}`,
        eventType
      }))).eventSummary.eventType).toBe(eventType);
    }
    const partialCopilot = payloadObject({
      revision: BigInt(2),
      eventType: "POINT_AWARDED",
      extra: { scorer_copilot_case_fingerprint: "3".repeat(64) }
    });
    expect(errorCode(() => parseVisionOutboxPayload(Buffer.from(canonical(partialCopilot)))))
      .toBe("COPILOT_IDENTITY_SET");
    const seedCopilot = payloadObject({
      extra: {
        review_authorization_context_fingerprint: "3".repeat(64),
        review_position: BigInt(1),
        scorer_copilot_case_fingerprint: "4".repeat(64),
        scorer_copilot_case_link_fingerprint: "5".repeat(64),
        scorer_copilot_signed_case_fingerprint: "6".repeat(64)
      }
    });
    expect(errorCode(() => parseVisionOutboxPayload(Buffer.from(canonical(seedCopilot)))))
      .toBe("COPILOT_EVENT_CORRELATION");
    const validCopilot = payloadObject({
      revision: BigInt(2),
      eventType: "POINT_AWARDED",
      extra: {
        review_authorization_context_fingerprint: "3".repeat(64),
        review_position: BigInt(1),
        scorer_copilot_case_fingerprint: "4".repeat(64),
        scorer_copilot_case_link_fingerprint: "5".repeat(64),
        scorer_copilot_signed_case_fingerprint: "6".repeat(64)
      }
    });
    expect(parseVisionOutboxPayload(Buffer.from(canonical(validCopilot))).reviewPosition).toBe("1");
  });

  it("rejects duplicate keys, non-canonical JSON, unsupported numbers, and deep trees", () => {
    const payload = makePayload();
    const duplicate = payload.replace(
      '"adopted_archive_fingerprint":',
      '"adopted_archive_fingerprint":"' + HASH + '","adopted_archive_fingerprint":'
    );
    expect(errorCode(() => parseVisionOutboxPayload(Buffer.from(duplicate)))).toBe("DUPLICATE_KEY");
    expect(errorCode(() => parseVisionOutboxPayload(Buffer.from(` ${payload}`)))).toBe("INVALID_JSON");
    expect(errorCode(() => parseVisionOutboxPayload(Buffer.from(payload.replace('"outbox_id":1', '"outbox_id":1.0')))))
      .toBe("JSON_NUMBER");
    const nested: CanonicalValue = {};
    let cursor = nested as Record<string, CanonicalValue>;
    for (let index = 0; index < 18; index += 1) {
      cursor.value = {};
      cursor = cursor.value as Record<string, CanonicalValue>;
    }
    expect(errorCode(() => parseVisionOutboxPayload(Buffer.from(canonical(nested)))))
      .toBe("JSON_DEPTH");
    const containerFlood = payloadObject({
      extra: { flood: Array.from({ length: 129 }, () => []) }
    });
    expect(errorCode(() => parseVisionOutboxPayload(Buffer.from(canonical(containerFlood)))))
      .toBe("JSON_CONTAINERS");
    expect(errorCode(() => parseVisionOutboxPayload(Buffer.alloc(16 * 1024 + 1, 0x61))))
      .toBe("RAW_SIZE");
  });

  it("rejects invalid signatures, payload hash changes, source drift, and scheduled revocation", () => {
    const corrupt = makeDispatch(makePayload(), { corruptSignature: true });
    expect(
      errorCode(() =>
        verifyVisionShadowDispatch(
          Buffer.from(corrupt.envelopeAscii),
          policyFor(corrupt),
          (corrupt.signedAt + BigInt(50)).toString(10)
        )
      )
    ).toBe("SIGNATURE_INVALID");

    const dispatch = makeDispatch();
    const envelope = JSON.parse(dispatch.envelopeAscii) as Record<string, unknown>;
    envelope.payload_sha256 = "0".repeat(64);
    expect(errorCode(() => verifyVisionShadowDispatch(
      Buffer.from(JSON.stringify(envelope)),
      policyFor(dispatch),
      (dispatch.signedAt + BigInt(50)).toString(10)
    ))).toBe("PAYLOAD_HASH");
    expect(errorCode(() => verifyVisionShadowDispatch(
      Buffer.from(dispatch.envelopeAscii),
      policyFor(dispatch, { sourceLedgerId: "ledger-2" }),
      (dispatch.signedAt + BigInt(50)).toString(10)
    ))).toBe("SOURCE_LEDGER_MISMATCH");
    expect(errorCode(() => verifyVisionShadowDispatch(
      Buffer.from(dispatch.envelopeAscii),
      policyFor(dispatch, { revokedAtNs: dispatch.expiresAt.toString(10) }),
      dispatch.signedAt.toString(10)
    ))).toBe("KEY_REVOKED");
  });

  it("rejects expired, future, over-lifetime, non-current, and oversized envelopes", () => {
    const dispatch = makeDispatch();
    expect(errorCode(() => verifyVisionShadowDispatch(
      Buffer.from(dispatch.envelopeAscii),
      policyFor(dispatch),
      (dispatch.expiresAt + BigInt(11)).toString(10)
    ))).toBe("DISPATCH_EXPIRED");
    expect(errorCode(() => verifyVisionShadowDispatch(
      Buffer.from(dispatch.envelopeAscii),
      policyFor(dispatch),
      (dispatch.signedAt - BigInt(11)).toString(10)
    ))).toBe("DISPATCH_FUTURE");
    const shortPolicy = { ...policyFor(dispatch), maximumEnvelopeLifetimeNs: "99" };
    expect(errorCode(() => verifyVisionShadowDispatch(
      Buffer.from(dispatch.envelopeAscii),
      shortPolicy,
      dispatch.signedAt.toString(10)
    ))).toBe("DISPATCH_LIFETIME");
    expect(errorCode(() => verifyVisionShadowDispatch(
      Buffer.from(dispatch.envelopeAscii),
      policyFor(dispatch, { currentKeyId: "unknown" }),
      dispatch.signedAt.toString(10)
    ))).toBe("KEY_REGISTRY");
    expect(errorCode(() => verifyVisionShadowDispatch(
      Buffer.alloc(32 * 1024 + 1, 0x61),
      policyFor(dispatch),
      dispatch.signedAt.toString(10)
    ))).toBe("RAW_SIZE");
  });

  it("requires an exact bounded protected key registry", () => {
    const dispatch = makeDispatch();
    const policy = policyFor(dispatch);
    const unknownPolicy = { ...policy, unexpected: true } as unknown as VisionDispatchTrustPolicy;
    expect(errorCode(() => verifyVisionShadowDispatch(
      Buffer.from(dispatch.envelopeAscii),
      unknownPolicy,
      dispatch.signedAt.toString(10)
    ))).toBe("TRUST_POLICY");
    const key = policy.registry.keys[0];
    const tooManyKeys: ProtectedVisionDispatcherRegistry = {
      ...policy.registry,
      keys: Array.from({ length: 65 }, (_, index) => ({
        ...key,
        dispatcherId: `dispatcher-${index}`,
        keyId: `key-${index}`,
        publicKeyBase64: Buffer.alloc(32, index).toString("base64")
      }))
    };
    expect(errorCode(() => verifyVisionShadowDispatch(
      Buffer.from(dispatch.envelopeAscii),
      { ...policy, registry: tooManyKeys },
      dispatch.signedAt.toString(10)
    ))).toBe("KEY_REGISTRY");
    const duplicateKeyPolicy: VisionDispatchTrustPolicy = {
      ...policy,
      registry: { ...policy.registry, keys: [key, { ...key }] }
    };
    expect(errorCode(() => verifyVisionShadowDispatch(
      Buffer.from(dispatch.envelopeAscii),
      duplicateKeyPolicy,
      dispatch.signedAt.toString(10)
    ))).toBe("KEY_REGISTRY");
  });
});

interface TestVisionReceipt {
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

function receipt(
  options: PayloadOptions = {},
  recordChanges: Partial<TestVisionReceipt> = {}
): TestVisionReceipt {
  const payloadAscii = makePayload(options);
  const dispatch = makeDispatch(payloadAscii, { attemptId: `attempt-${options.revision ?? BigInt(1)}` });
  const payload = parseVisionOutboxPayload(Buffer.from(payloadAscii));
  return {
    sourceLedgerId: "ledger-1",
    outboxId: payload.outboxId,
    messageId: payload.messageId,
    sourceMatchId: payload.sourceMatchId,
    sourceRevision: payload.sourceRevision,
    sourceEventId: payload.sourceEventId,
    sourcePayloadCanonicalAscii: payloadAscii,
    payloadSha256: payload.payloadSha256,
    transportEnvelopeCanonicalAscii: dispatch.envelopeAscii,
    transportEnvelopeSha256: sha256(Buffer.from(dispatch.envelopeAscii)),
    dispatcherId: "dispatcher-1",
    dispatcherKeyId: "dispatch-key-1",
    dispatchAttemptId: `attempt-${payload.sourceRevision}`,
    dispatchSignedAtNs: dispatch.signedAt.toString(10),
    dispatchExpiresAtNs: dispatch.expiresAt.toString(10),
    receivedAtNs: (dispatch.signedAt + BigInt(50)).toString(10),
    ...recordChanges
  };
}

const REPLAY_POLICY = policyFor(makeDispatch());
const resolveReplayPolicy = () => REPLAY_POLICY;

function fixedReadRecord(receiptValue: TestVisionReceipt): Record<string, unknown> {
  const payload = parseVisionOutboxPayload(
    Buffer.from(receiptValue.sourcePayloadCanonicalAscii, "ascii")
  );
  return {
    schema_version: "1.0",
    row_kind: "RECEIPT",
    integrity_block_code: null,
    source_ledger_id: receiptValue.sourceLedgerId,
    source_match_id: receiptValue.sourceMatchId,
    outbox_id: receiptValue.outboxId,
    message_id: receiptValue.messageId,
    source_revision: receiptValue.sourceRevision,
    source_event_id: receiptValue.sourceEventId,
    source_payload_base64: Buffer.from(receiptValue.sourcePayloadCanonicalAscii, "ascii").toString("base64"),
    payload_sha256: receiptValue.payloadSha256,
    transport_envelope_base64: Buffer.from(
      receiptValue.transportEnvelopeCanonicalAscii,
      "ascii"
    ).toString("base64"),
    transport_envelope_sha256: receiptValue.transportEnvelopeSha256,
    dispatcher_id: receiptValue.dispatcherId,
    dispatcher_key_id: receiptValue.dispatcherKeyId,
    dispatch_attempt_id: receiptValue.dispatchAttemptId,
    dispatch_signed_at_ns: receiptValue.dispatchSignedAtNs,
    dispatch_expires_at_ns: receiptValue.dispatchExpiresAtNs,
    received_at_ns: receiptValue.receivedAtNs,
    appended_at_ns: payload.appendedAtNs,
    event_type: payload.eventSummary.eventType,
    event_summary: JSON.parse(payload.eventSummaryDecimalJson),
    post_state_summary: JSON.parse(payload.postStateSummaryDecimalJson),
    ruleset_id: payload.rulesetId,
    ruleset_version: payload.rulesetVersion,
    ruleset_fingerprint: payload.rulesetFingerprint,
    reducer_build_sha256: payload.reducerBuildSha256,
    adopted_archive_fingerprint: payload.adoptedArchiveFingerprint,
    authorization_record_fingerprint: payload.authorizationRecordFingerprint,
    source_envelope_fingerprint: payload.envelopeFingerprint,
    event_fingerprint: payload.eventFingerprint,
    state_fingerprint: payload.stateFingerprint,
    review_history_head_sha256: payload.reviewHistoryHeadSha256,
    review_position: payload.reviewPosition,
    scorer_copilot_case_fingerprint: payload.scorerCopilotCaseFingerprint,
    scorer_copilot_signed_case_fingerprint: payload.scorerCopilotSignedCaseFingerprint,
    scorer_copilot_case_link_fingerprint: payload.scorerCopilotCaseLinkFingerprint,
    review_authorization_context_fingerprint: payload.reviewAuthorizationContextFingerprint
  };
}

function fixedReadMeta(block: string | null = null): Record<string, unknown> {
  return {
    schema_version: "1.0",
    row_kind: "META",
    integrity_block_code: block,
    source_ledger_id: "ledger-1",
    source_match_id: "vision-match-1"
  };
}

async function readProjection(
  receipts: readonly TestVisionReceipt[],
  options: {
    readonly block?: string | null;
    readonly resolveHistoricalTrust?: VisionHistoricalTrustResolver;
  } = {}
): Promise<VisionShadowProjection> {
  return readVerifiedVisionShadowProjection({
    sourceLedgerId: "ledger-1",
    sourceMatchId: "vision-match-1",
    resolveHistoricalTrust: options.resolveHistoricalTrust ?? resolveReplayPolicy,
    async callFixedReadRpc() {
      return {
        data: [
          { record: fixedReadMeta(options.block ?? null) },
          ...receipts.map((receiptValue) => ({ record: fixedReadRecord(receiptValue) }))
        ],
        error: null
      };
    }
  });
}

describe("vision-only projection through the fixed verified read", () => {
  it("sorts out-of-order delivery and advances only a contiguous single lineage", async () => {
    const first = receipt({ revision: BigInt(1), eventType: "SET_SEED" });
    const second = receipt({ revision: BigInt(2), eventType: "POINT_AWARDED" });
    const projection = await readProjection([second, first]);
    expect(projection.status).toBe("VERIFIED_RECEIPT_PREFIX");
    expect(projection.lastContiguousRevision).toBe("2");
    expect(projection.latestEventId).toBe("event+2");
    expect(projection.latestPostStateSummary?.currentSet?.teamAPoints).toBe("1");
  });

  it("blocks gaps without advancing and recovers only when full history is present", async () => {
    const first = receipt({ revision: BigInt(1), eventType: "SET_SEED" });
    const third = receipt({ revision: BigInt(3), eventType: "POINT_AWARDED" });
    expect(await readProjection([first, third])).toMatchObject({
      status: "INTEGRITY_BLOCKED",
      blockCode: "SOURCE_REVISION_GAP",
      lastContiguousRevision: "1"
    });
    const second = receipt({ revision: BigInt(2), eventType: "POINT_AWARDED" });
    expect(await readProjection([third, first, second])).toMatchObject({
      status: "VERIFIED_RECEIPT_PREFIX",
      lastContiguousRevision: "3"
    });
  });

  it("blocks reducer/ruleset drift and duplicate source identities", async () => {
    const first = receipt({ revision: BigInt(1), eventType: "SET_SEED" });
    const lineageDrift = receipt({
      revision: BigInt(2),
      eventType: "POINT_AWARDED",
      reducerBuildSha256: "9".repeat(64)
    });
    expect((await readProjection([first, lineageDrift])).blockCode)
      .toBe("SOURCE_LINEAGE_CONFLICT");
    expect((await readProjection([first, first])).blockCode)
      .toBe("SOURCE_IDENTITY_CONFLICT");
  });

  it("rejects payload and derived fingerprint drift at the fixed read contract", async () => {
    const first = receipt({ revision: BigInt(1), eventType: "SET_SEED" });
    await expect(readProjection([{ ...first, payloadSha256: "0".repeat(64) }]))
      .rejects.toThrow("VISION_RECEIPT_READ_CONTRACT");
    const trailingPayloadRow = fixedReadRecord(first);
    trailingPayloadRow.source_payload_base64 = Buffer.from(
      `${first.sourcePayloadCanonicalAscii} `,
      "ascii"
    ).toString("base64");
    await expect(readVerifiedVisionShadowProjection({
      sourceLedgerId: "ledger-1",
      sourceMatchId: "vision-match-1",
      resolveHistoricalTrust: resolveReplayPolicy,
      async callFixedReadRpc() {
        return {
          data: [{ record: fixedReadMeta() }, { record: trailingPayloadRow }],
          error: null
        };
      }
    })).rejects.toThrow("VISION_RECEIPT_READ_CONTRACT");
  });

  it("re-verifies signatures and distinguishes missing or revoked historical trust", async () => {
    const first = receipt({ revision: BigInt(1), eventType: "SET_SEED" });
    const substitutedPayload = makePayload({
      revision: BigInt(1),
      eventType: "SET_SEED",
      extra: { state_fingerprint: "9".repeat(64) }
    });
    const substitutedDispatch = makeDispatch(substitutedPayload, {
      attemptId: "attempt-1",
      corruptSignature: true
    });
    const parsed = parseVisionOutboxPayload(Buffer.from(substitutedPayload));
    const coordinatedSubstitution: TestVisionReceipt = {
      ...first,
      sourcePayloadCanonicalAscii: substitutedPayload,
      payloadSha256: parsed.payloadSha256,
      transportEnvelopeCanonicalAscii: substitutedDispatch.envelopeAscii,
      transportEnvelopeSha256: sha256(Buffer.from(substitutedDispatch.envelopeAscii))
    };
    expect((await readProjection([coordinatedSubstitution])).blockCode)
      .toBe("RECEIPT_TAMPERED");
    expect((await readProjection([first], { resolveHistoricalTrust: () => null })).blockCode)
      .toBe("HISTORICAL_TRUST_UNAVAILABLE");
    const revokedPolicy = policyFor(makeDispatch(), {
      revokedAtNs: (BASE_TIME + BigInt(200)).toString(10)
    });
    expect((await readProjection([first], {
      resolveHistoricalTrust: () => revokedPolicy
    })).blockCode).toBe("DISPATCH_KEY_REVOKED");
  });

  it("rejects a response beyond the fixed 4096-event maximum", async () => {
    const first = receipt({ revision: BigInt(1), eventType: "SET_SEED" });
    await expect(readProjection(Array.from({ length: 4097 }, () => first)))
      .rejects.toThrow("VISION_RECEIPT_READ_CONTRACT");
  });
});

describe("fixed verified vision receipt reads", () => {
  it("returns only a historical-signature-verified projection from decimal-text rows", async () => {
    const first = receipt({ revision: BigInt(1), eventType: "SET_SEED" });
    const second = receipt({ revision: BigInt(2), eventType: "POINT_AWARDED" });
    const calls: unknown[] = [];
    const projection = await readVerifiedVisionShadowProjection({
      sourceLedgerId: "ledger-1",
      sourceMatchId: "vision-match-1",
      resolveHistoricalTrust: resolveReplayPolicy,
      async callFixedReadRpc(arguments_) {
        calls.push(arguments_);
        return {
          data: [
            { record: fixedReadMeta() },
            { record: fixedReadRecord(first) },
            { record: fixedReadRecord(second) }
          ],
          error: null
        };
      }
    });
    expect(calls).toEqual([{
      p_source_ledger_id: "ledger-1",
      p_source_match_id: "vision-match-1"
    }]);
    expect(projection).toMatchObject({
      status: "VERIFIED_RECEIPT_PREFIX",
      lastContiguousRevision: "2",
      latestEventId: "event+2"
    });
  });

  it("honors the protected verifier's clock skew instead of imposing zero skew", async () => {
    const first = receipt({ revision: BigInt(1), eventType: "SET_SEED" });
    const withinProtectedSkew: TestVisionReceipt = {
      ...first,
      receivedAtNs: (BigInt(first.dispatchSignedAtNs) - BigInt(5)).toString(10)
    };
    expect(await readProjection([withinProtectedSkew])).toMatchObject({
      status: "VERIFIED_RECEIPT_PREFIX",
      lastContiguousRevision: "1"
    });
  });

  it("rejects numeric int8/JSON values and derived-column drift before replay", async () => {
    const first = receipt({ revision: BigInt(1), eventType: "SET_SEED" });
    const base = fixedReadRecord(first);
    for (const changed of [
      { ...base, received_at_ns: 1700000000000000000 },
      {
        ...base,
        event_summary: {
          ...(base.event_summary as Record<string, unknown>),
          evidence_count: 0
        }
      },
      { ...base, state_fingerprint: "9".repeat(64) }
    ]) {
      await expect(readVerifiedVisionShadowProjection({
        sourceLedgerId: "ledger-1",
        sourceMatchId: "vision-match-1",
        resolveHistoricalTrust: resolveReplayPolicy,
        async callFixedReadRpc() {
          return {
            data: [{ record: fixedReadMeta() }, { record: changed }],
            error: null
          };
        }
      })).rejects.toThrow("VISION_RECEIPT_READ_CONTRACT");
    }
  });

  it("applies terminal source integrity while preserving the verified prefix", async () => {
    const first = receipt({ revision: BigInt(1), eventType: "SET_SEED" });
    const projection = await readVerifiedVisionShadowProjection({
      sourceLedgerId: "ledger-1",
      sourceMatchId: "vision-match-1",
      resolveHistoricalTrust: resolveReplayPolicy,
      async callFixedReadRpc() {
        return {
          data: [
            { record: fixedReadMeta("SOURCE_IDENTITY_CONFLICT") },
            { record: fixedReadRecord(first) }
          ],
          error: null
        };
      }
    });
    expect(projection).toMatchObject({
      status: "INTEGRITY_BLOCKED",
      blockCode: "SOURCE_IDENTITY_CONFLICT",
      lastContiguousRevision: "1",
      latestEventId: "event+seed"
    });
  });

  it("never returns a projection without replaying the exact stored transport signature", async () => {
    const first = receipt({ revision: BigInt(1), eventType: "SET_SEED" });
    const row = fixedReadRecord(first);
    const envelope = Buffer.from(
      exactStringForTest(row.transport_envelope_base64),
      "base64"
    ).toString("ascii");
    const tamperedEnvelope = envelope.replace('"attempt_id":"attempt-1"', '"attempt_id":"attempt-x"');
    row.transport_envelope_base64 = Buffer.from(tamperedEnvelope, "ascii").toString("base64");
    row.transport_envelope_sha256 = sha256(Buffer.from(tamperedEnvelope, "ascii"));
    row.dispatch_attempt_id = "attempt-x";
    const projection = await readVerifiedVisionShadowProjection({
      sourceLedgerId: "ledger-1",
      sourceMatchId: "vision-match-1",
      resolveHistoricalTrust: resolveReplayPolicy,
      async callFixedReadRpc() {
        return {
          data: [{ record: fixedReadMeta() }, { record: row }],
          error: null
        };
      }
    });
    expect(projection.blockCode).toBe("RECEIPT_TAMPERED");
  });
});

function exactStringForTest(value: unknown): string {
  if (typeof value !== "string") throw new Error("test fixture must be a string");
  return value;
}

describe("vision shadow ingest core and fixed persistence boundary", () => {
  it("passes only authenticated source facts to one narrow persistence operation", async () => {
    const dispatch = makeDispatch();
    const commands: unknown[] = [];
    const persistence: VisionShadowReceiptPersistence = {
      async acceptAuthenticatedVisionReceipt(command) {
        commands.push(command);
        return { kind: "INSERTED" };
      }
    };
    const result = await ingestVisionShadowDispatch({
      envelopeBytes: Buffer.from(dispatch.envelopeAscii),
      trustPolicy: policyFor(dispatch),
      protectedNowNs: (dispatch.signedAt + BigInt(50)).toString(10),
      persistence
    });
    expect(result).toMatchObject({ kind: "INSERTED", officialScoreAuthorityGranted: false });
    expect(commands).toHaveLength(1);
    const command = commands[0] as Record<string, unknown>;
    expect(command.sourceLedgerId).toBe("ledger-1");
    expect(Object.keys(command).some((key) => key.startsWith("scorecheck"))).toBe(false);
  });

  it("does not invoke persistence when authentication fails", async () => {
    const dispatch = makeDispatch(makePayload(), { corruptSignature: true });
    let calls = 0;
    const persistence: VisionShadowReceiptPersistence = {
      async acceptAuthenticatedVisionReceipt() {
        calls += 1;
        return { kind: "INSERTED" };
      }
    };
    await expect(ingestVisionShadowDispatch({
      envelopeBytes: Buffer.from(dispatch.envelopeAscii),
      trustPolicy: policyFor(dispatch),
      protectedNowNs: (dispatch.signedAt + BigInt(50)).toString(10),
      persistence
    })).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    expect(calls).toBe(0);
  });

  it("propagates fail-closed binding outcomes without retrying another destination", async () => {
    const dispatch = makeDispatch();
    const result = await ingestVisionShadowDispatch({
      envelopeBytes: Buffer.from(dispatch.envelopeAscii),
      trustPolicy: policyFor(dispatch),
      protectedNowNs: (dispatch.signedAt + BigInt(50)).toString(10),
      persistence: {
        async acceptAuthenticatedVisionReceipt() {
          return { kind: "BINDING_REJECTED", reason: "REASSIGNED_BINDING" };
        }
      }
    });
    expect(result.outcome).toEqual({ kind: "BINDING_REJECTED", reason: "REASSIGNED_BINDING" });
  });

  it("adapts to exactly one fixed RPC with bytea values and no destination parameters", async () => {
    const calls: unknown[] = [];
    const persistence = fixedVisionReceiptPersistence(async (arguments_) => {
      calls.push(arguments_);
      return {
        data: [{ result_code: "EXACT_RETRY", result_detail: null }],
        error: null
      };
    });
    const dispatch = makeDispatch();
    const result = await ingestVisionShadowDispatch({
      envelopeBytes: Buffer.from(dispatch.envelopeAscii),
      trustPolicy: policyFor(dispatch),
      protectedNowNs: (dispatch.signedAt + BigInt(50)).toString(10),
      persistence
    });
    expect(result.kind).toBe("EXACT_RETRY");
    expect(calls).toHaveLength(1);
    const arguments_ = calls[0] as Record<string, string>;
    expect(Object.keys(arguments_).sort()).toEqual([
      "p_received_at_ns",
      "p_source_payload_bytes",
      "p_transport_envelope_bytes"
    ]);
    expect(Buffer.from(arguments_.p_source_payload_bytes.slice(2), "hex").toString("ascii"))
      .toBe(dispatch.payloadAscii);
  });

  it("cannot invoke the fixed writer with a structurally forged unverified command", async () => {
    let calls = 0;
    const persistence = fixedVisionReceiptPersistence(async () => {
      calls += 1;
      return { data: null, error: null };
    });
    await expect(
      persistence.acceptAuthenticatedVisionReceipt({} as never)
    ).rejects.toThrow("VISION_AUTHENTICATION_REQUIRED");
    expect(calls).toBe(0);
  });

  it("rejects obsolete or extra fixed-write RPC result fields", async () => {
    const dispatch = makeDispatch();
    await expect(ingestVisionShadowDispatch({
      envelopeBytes: Buffer.from(dispatch.envelopeAscii),
      trustPolicy: policyFor(dispatch),
      protectedNowNs: (dispatch.signedAt + BigInt(50)).toString(10),
      persistence: fixedVisionReceiptPersistence(async () => ({
        data: [{
          result_code: "INSERTED",
          result_detail: null,
          projection_status: "VERIFIED_RECEIPT_PREFIX"
        } as never],
        error: null
      }))
    })).rejects.toThrow("fixed RPC row fields are invalid");
  });

  it("rejects a Proxy wrapping a genuinely authenticated command by object identity", async () => {
    let genuine: AuthenticatedVisionReceiptCommand | null = null;
    const dispatch = makeDispatch();
    await ingestVisionShadowDispatch({
      envelopeBytes: Buffer.from(dispatch.envelopeAscii),
      trustPolicy: policyFor(dispatch),
      protectedNowNs: (dispatch.signedAt + BigInt(50)).toString(10),
      persistence: {
        async acceptAuthenticatedVisionReceipt(command) {
          genuine = command;
          return { kind: "INSERTED" };
        }
      }
    });
    expect(genuine).not.toBeNull();
    let calls = 0;
    const persistence = fixedVisionReceiptPersistence(async () => {
      calls += 1;
      return { data: null, error: null };
    });
    const forgedProxy = new Proxy(
      genuine as unknown as AuthenticatedVisionReceiptCommand,
      {}
    );
    await expect(
      persistence.acceptAuthenticatedVisionReceipt(forgedProxy)
    ).rejects.toThrow("VISION_AUTHENTICATION_REQUIRED");
    expect(calls).toBe(0);
  });
});

function filesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

describe("vision shadow repository isolation guard", () => {
  it("keeps the PostgreSQL behavior harness fixed, isolated, and digest-pinned", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8")
    ) as { readonly scripts?: Record<string, string> };
    const harness = readFileSync(
      resolve(process.cwd(), "src/scripts/testVisionPostgres.ts"),
      "utf8"
    );
    const fixture = readFileSync(
      resolve(process.cwd(), "src/scripts/fixtures/visionShadowPostgres.sql"),
      "utf8"
    );
    expect(packageJson.scripts?.["test:vision-postgres"])
      .toBe("tsx src/scripts/testVisionPostgres.ts");
    expect(harness).toContain(
      "postgres@sha256:3d0f7584ed7d04e27fa050d6683a74746608faf21f202be78460d679cc56461f"
    );
    for (const migrationFile of [
      "001_initial_schema.sql",
      "002_remote_manual_scoring_and_worker.sql",
      "003_fan_scoring_claims_sessions_video.sql",
      "004_vbl_source_priority.sql",
      "009_vbl_overlay_delay.sql",
      "010_mediamtx_stream_paths.sql",
      "011_instant_scoring.sql",
      "012_program_heartbeats.sql",
      "013_youtube_stream_keys.sql",
      "014_chat_messages.sql",
      "015_program_media_paths.sql",
      "016_commentary_sync_clock.sql"
    ]) {
      expect(harness).toContain(migrationFile);
    }
    expect(harness).toContain("supabase/migrations/017_vision_shadow_receipts.sql");
    expect(harness).toContain("create schema auth");
    expect(harness).toContain("create function realtime.send");
    expect(harness).toContain('"--network=none"');
    expect(harness).toContain('"--set=ON_ERROR_STOP=1"');
    expect(harness).toContain("/ERROR:\\s+42501:/m");
    expect(harness).toContain("READINESS_TIMEOUT_MS = 60_000");
    expect(harness).toContain("READINESS_PROBE_TIMEOUT_MS = 5_000");
    expect(harness).toContain("performance.now() + READINESS_TIMEOUT_MS");
    expect(harness).toContain("{ timeoutMs: probeBudget }");
    expect(harness).toContain("shell: false");
    expect(harness).toContain("finally");
    expect(harness).toContain('docker(["rm", "--force", containerName]');
    expect(harness.match(/removeContainerIfPresent\(containerName\)/g)?.length)
      .toBeGreaterThanOrEqual(3);
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
      expect(harness).toContain(signal);
    }
    expect(harness).not.toContain('"--publish"');
    expect(harness).not.toMatch(/["']-p["']/);
    expect(harness).not.toMatch(/spawnSync\(["']colima["']/);
    for (const behavior of [
      "immutable binding unexpectedly accepted a rebind",
      "golden receipt insert returned",
      "golden receipt retry returned",
      "fixed read did not return the exact META + RECEIPT contract",
      "append-only receipt unexpectedly accepted an update",
      "RLS exposed",
      "conflicting receipt returned",
      "terminal block did not preserve the fixed read prefix",
      "migration 017 stranded a live public-function column default",
      "service_role could not perform a current-schema default insert",
      "broadcast trigger did not call the realtime.send stub"
    ]) {
      expect(fixture).toContain(behavior);
    }
  });

  it("keeps raw receipts and replay private behind the fixed verified reader", () => {
    const libraryDirectory = resolve(process.cwd(), "src/lib/vision-shadow");
    const indexText = readFileSync(join(libraryDirectory, "index.ts"), "utf8");
    const readerText = readFileSync(join(libraryDirectory, "fixedReadProjection.ts"), "utf8");
    expect(readdirSync(libraryDirectory)).not.toContain("projection.ts");
    expect(indexText).not.toContain('"./projection"');
    expect(indexText).not.toContain("replayVisionShadowReceipts");
    expect(readerText).not.toMatch(/export\s+(?:interface|type)\s+VisionShadowReceiptRecord/);
    expect(readerText).not.toMatch(/export\s+(?:async\s+)?function\s+replay/);
    expect(readerText).not.toMatch(/scorecheck(?:Event|Court|Match)Id|bindingGeneration/);
    expect(readerText).toContain("MAX_FIXED_READ_WIRE_BYTES = 48 * 1024 * 1024");
  });

  it("keeps the adapter and migration outside every existing mutation-capable path", () => {
    const libraryDirectory = resolve(process.cwd(), "src/lib/vision-shadow");
    const migration = resolve(process.cwd(), "supabase/migrations/017_vision_shadow_receipts.sql");
    const productionText = [...filesBelow(libraryDirectory), migration]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const forbidden = [
      "score_states",
      "overlay_states",
      "score_actions",
      "scorer_shadow_states",
      "court_flags",
      "scorerSessions",
      "manualScoreApi",
      "admin-score"
    ];
    for (const token of forbidden) expect(productionText).not.toContain(token);
    expect(productionText).not.toContain("on delete cascade");
    expect(productionText).not.toContain("FEATURE_FLAG");
  });

  it("creates only vision-prefixed relations/functions and enforces immutable receipts", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/017_vision_shadow_receipts.sql"),
      "utf8"
    );
    const createdRelations = [...migration.matchAll(/create table public\.([a-z0-9_]+)/g)].map((match) => match[1]);
    const createdFunctions = [...migration.matchAll(/create or replace function public\.([a-z0-9_]+)/g)]
      .map((match) => match[1]);
    expect(createdRelations.length).toBeGreaterThan(0);
    expect(createdRelations.every((name) => name.startsWith("vision_"))).toBe(true);
    expect(createdFunctions.every((name) => name.startsWith("vision_"))).toBe(true);
    expect(migration).toContain("vision_shadow_receipts_append_only");
    expect(migration).toContain("before update or delete on public.vision_shadow_receipts");
    expect(migration).toContain("grant execute on function public.vision_accept_shadow_receipt");
  });

  it("limits every SQL write/trigger to vision relations and encodes fail-closed receipt semantics", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/017_vision_shadow_receipts.sql"),
      "utf8"
    );
    const writeTargets = [
      ...migration.matchAll(/(?:insert into|update|delete from)\s+public\.([a-z0-9_]+)/gi)
    ].map((match) => match[1]);
    const triggerTargets = [...migration.matchAll(/(?:before|after)\s+[^;]+?\s+on\s+public\.([a-z0-9_]+)/gi)]
      .map((match) => match[1]);
    expect(writeTargets.length).toBeGreaterThan(0);
    expect(writeTargets.every((name) => name.startsWith("vision_"))).toBe(true);
    expect(triggerTargets.every((name) => name.startsWith("vision_"))).toBe(true);
    for (const rejection of [
      "MISSING_BINDING",
      "STALE_BINDING",
      "REASSIGNED_BINDING"
    ]) {
      expect(migration).toContain(rejection);
    }
    expect(migration).toContain("v_existing.source_payload_bytes = p_source_payload_bytes");
    expect(migration).toContain("IDENTITY_CONFLICT");
    expect(migration).toContain("SOURCE_IDENTITY_CONFLICT");
    expect(migration).toContain("SOURCE_LINEAGE_CONFLICT");
    expect(migration).toContain("v_appended_at_ns < v_binding.active_from_ns");
    expect(migration).toContain(
      "vision_binding_lock_key(p_source_ledger_id, p_source_match_id)"
    );
    expect(migration).toContain(
      "vision_binding_lock_key(v_source_ledger_id, v_source_match_id)"
    );
    expect(migration).not.toContain("vision_match_binding_closures");
    expect(migration).not.toContain("vision_shadow_match_projection");
    expect(migration).not.toMatch(/grant select on table public\.vision_/i);
    expect(migration).toContain("vision_read_shadow_receipts");
    expect(migration).toContain("vision_jsonb_ints_as_text");
    expect(migration).toContain("enable row level security");
    expect(migration).toContain(
      "nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit"
    );
    expect(migration).toContain("where member.rolname = v_capability");
    expect(migration).toContain("where capability.rolname = v_capability");
    expect(migration).toContain("revoke all privileges on database %I from %I");
    expect(migration).toContain("revoke all privileges on all tables in schema public");
    expect(migration).toContain("revoke all privileges on all functions in schema public");
    expect(migration).toContain(
      "alter default privileges in schema public revoke execute on functions from public"
    );
    expect(migration).toContain("revoke execute on all functions in schema public from public");
    expect(migration).toContain("has_function_privilege(v_capability, procedure.oid, 'EXECUTE')");
    expect(migration).toContain("has_table_privilege(v_capability, object.oid, 'SELECT')");
    expect(migration).toContain("has_sequence_privilege(v_capability, object.oid, 'USAGE')");
    expect(migration).toContain("has_schema_privilege(v_capability, 'public', 'CREATE')");
    expect(migration).toContain("v_receipt_count > 4096");
    expect(migration).toContain("v_total_source_bytes > 33554432");
    for (const integerColumn of [
      "outbox_id",
      "source_revision",
      "dispatch_signed_at_ns",
      "dispatch_expires_at_ns",
      "received_at_ns",
      "appended_at_ns",
      "review_position"
    ]) {
      expect(migration).toContain(`receipt.${integerColumn}::text`);
    }
    expect(migration).toContain("externally protected");
    expect(migration).toContain("'vision_shadow_ingest'");
    expect(migration).not.toMatch(/grant execute[\s\S]*?service_role/i);
    expect([
      ...migration.matchAll(/grant execute on function public\.([a-z0-9_]+)/g)
    ].map((match) => match[1]).sort()).toEqual([
      "vision_accept_shadow_receipt",
      "vision_publish_match_binding",
      "vision_read_shadow_receipts"
    ]);

    const receiptBuilder = migration.match(
      /return query\n\s+select jsonb_build_object\(([\s\S]*?)\)\s+from public\.vision_shadow_receipts receipt/
    );
    expect(receiptBuilder).not.toBeNull();
    const sqlReadFields = [
      ...receiptBuilder![1].matchAll(/^\s*'([a-z0-9_]+)',/gm)
    ].map((match) => match[1]).sort();
    const fixtureReadFields = Object.keys(
      fixedReadRecord(receipt({ revision: BigInt(1), eventType: "SET_SEED" }))
    ).sort();
    expect(sqlReadFields).toEqual(fixtureReadFields);
    for (const privateField of [
      "binding_generation",
      "scorecheck_event_id",
      "scorecheck_court_id",
      "scorecheck_match_id"
    ]) {
      expect(sqlReadFields).not.toContain(privateField);
    }
  });

  it("keeps each security-sensitive function clause singular", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/017_vision_shadow_receipts.sql"),
      "utf8"
    );
    const header = (name: string) => {
      const match = migration.match(
        new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\nas \\$\\$`)
      );
      expect(match, `${name} function header`).not.toBeNull();
      return match![0];
    };
    expect(header("vision_binding_lock_key").match(/^immutable$/gm)).toHaveLength(1);
    expect(header("vision_read_shadow_receipts").match(/^set search_path = pg_catalog, public$/gm))
      .toHaveLength(1);
  });
});
