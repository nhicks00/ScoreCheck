import {
  verifyVisionShadowDispatch,
  type VisionDispatchTrustPolicy,
  type VisionEventSummary,
  type VisionPostStateSummary
} from "./transport";

const authenticatedVisionReceiptCommands = new WeakSet<object>();

export type VisionBindingRejection =
  | "MISSING_BINDING"
  | "STALE_BINDING"
  | "REASSIGNED_BINDING";

export type VisionPersistenceOutcome =
  | { readonly kind: "INSERTED" }
  | { readonly kind: "EXACT_RETRY" }
  | { readonly kind: "BINDING_REJECTED"; readonly reason: VisionBindingRejection }
  | { readonly kind: "INTEGRITY_BLOCKED"; readonly reason: string }
  | { readonly kind: "SOURCE_BLOCKED"; readonly reason: string };

/**
 * The command deliberately contains only authenticated source identities.
 * A persistence implementation must resolve the protected binding atomically;
 * no caller-selected ScoreCheck destination can cross this interface.
 */
export interface AuthenticatedVisionReceiptCommand {
  readonly sourceLedgerId: string;
  readonly sourceMatchId: string;
  readonly outboxId: string;
  readonly messageId: string;
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
  readonly appendedAtNs: string;
  readonly eventSummary: VisionEventSummary;
  readonly postStateSummary: VisionPostStateSummary;
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

export function assertAuthenticatedVisionReceiptCommand(
  command: AuthenticatedVisionReceiptCommand
): void {
  if (
    !command ||
    typeof command !== "object" ||
    !authenticatedVisionReceiptCommands.has(command)
  ) {
    throw new Error("VISION_AUTHENTICATION_REQUIRED: receipt command was not created by verified ingest");
  }
}

export interface VisionShadowReceiptPersistence {
  /**
   * In one transaction: detect exact retry/identity conflicts, resolve exactly
   * one active protected binding, confirm the court still names that match,
   * append the receipt, and expose it only through the fixed verified read path.
   */
  acceptAuthenticatedVisionReceipt(
    command: AuthenticatedVisionReceiptCommand
  ): Promise<VisionPersistenceOutcome>;
}

export interface VisionShadowIngestResult {
  readonly kind: VisionPersistenceOutcome["kind"];
  readonly officialScoreAuthorityGranted: false;
  readonly outcome: VisionPersistenceOutcome;
}

function validatePersistenceOutcome(outcome: VisionPersistenceOutcome): void {
  if (!outcome || typeof outcome !== "object" || typeof outcome.kind !== "string") {
    throw new Error("VISION_PERSISTENCE_CONTRACT: persistence returned an invalid outcome");
  }
  if (outcome.kind === "INSERTED" || outcome.kind === "EXACT_RETRY") {
    return;
  }
  if (outcome.kind === "BINDING_REJECTED") {
    if (
      ![
        "MISSING_BINDING",
        "STALE_BINDING",
        "REASSIGNED_BINDING"
      ].includes(outcome.reason)
    ) {
      throw new Error("VISION_PERSISTENCE_CONTRACT: binding rejection is invalid");
    }
    return;
  }
  if (
    (outcome.kind === "INTEGRITY_BLOCKED" || outcome.kind === "SOURCE_BLOCKED") &&
    typeof outcome.reason === "string" &&
    outcome.reason.length >= 1 &&
    outcome.reason.length <= 128
  ) {
    return;
  }
  throw new Error("VISION_PERSISTENCE_CONTRACT: persistence returned an unsupported outcome");
}

export async function ingestVisionShadowDispatch(input: {
  readonly envelopeBytes: Uint8Array;
  readonly trustPolicy: VisionDispatchTrustPolicy;
  readonly protectedNowNs: string;
  readonly persistence: VisionShadowReceiptPersistence;
}): Promise<VisionShadowIngestResult> {
  if (!input.persistence || typeof input.persistence.acceptAuthenticatedVisionReceipt !== "function") {
    throw new Error("VISION_PERSISTENCE_CONTRACT: fixed vision receipt persistence is required");
  }
  const verified = verifyVisionShadowDispatch(
    input.envelopeBytes,
    input.trustPolicy,
    input.protectedNowNs
  );
  const payload = verified.payload;
  const command: AuthenticatedVisionReceiptCommand = {
    sourceLedgerId: verified.sourceLedgerId,
    sourceMatchId: payload.sourceMatchId,
    outboxId: payload.outboxId,
    messageId: payload.messageId,
    sourceRevision: payload.sourceRevision,
    sourceEventId: payload.sourceEventId,
    sourcePayloadCanonicalAscii: payload.canonicalAscii,
    payloadSha256: payload.payloadSha256,
    transportEnvelopeCanonicalAscii: verified.envelopeCanonicalAscii,
    transportEnvelopeSha256: verified.envelopeSha256,
    dispatcherId: verified.dispatcherId,
    dispatcherKeyId: verified.dispatcherKeyId,
    dispatchAttemptId: verified.attemptId,
    dispatchSignedAtNs: verified.signedAtNs,
    dispatchExpiresAtNs: verified.expiresAtNs,
    receivedAtNs: input.protectedNowNs,
    appendedAtNs: payload.appendedAtNs,
    eventSummary: payload.eventSummary,
    postStateSummary: payload.postStateSummary,
    rulesetId: payload.rulesetId,
    rulesetVersion: payload.rulesetVersion,
    rulesetFingerprint: payload.rulesetFingerprint,
    reducerBuildSha256: payload.reducerBuildSha256,
    adoptedArchiveFingerprint: payload.adoptedArchiveFingerprint,
    authorizationRecordFingerprint: payload.authorizationRecordFingerprint,
    envelopeFingerprint: payload.envelopeFingerprint,
    eventFingerprint: payload.eventFingerprint,
    stateFingerprint: payload.stateFingerprint,
    reviewHistoryHeadSha256: payload.reviewHistoryHeadSha256,
    reviewPosition: payload.reviewPosition,
    scorerCopilotCaseFingerprint: payload.scorerCopilotCaseFingerprint,
    scorerCopilotSignedCaseFingerprint: payload.scorerCopilotSignedCaseFingerprint,
    scorerCopilotCaseLinkFingerprint: payload.scorerCopilotCaseLinkFingerprint,
    reviewAuthorizationContextFingerprint: payload.reviewAuthorizationContextFingerprint
  };
  authenticatedVisionReceiptCommands.add(command);
  Object.freeze(command);
  const outcome = await input.persistence.acceptAuthenticatedVisionReceipt(command);
  validatePersistenceOutcome(outcome);
  return Object.freeze({ kind: outcome.kind, officialScoreAuthorityGranted: false, outcome });
}
