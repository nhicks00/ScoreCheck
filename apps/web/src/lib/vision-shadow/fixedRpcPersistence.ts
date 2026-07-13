import {
  assertAuthenticatedVisionReceiptCommand,
  type AuthenticatedVisionReceiptCommand,
  type VisionBindingRejection,
  type VisionPersistenceOutcome,
  type VisionShadowReceiptPersistence
} from "./ingest";

export interface FixedVisionReceiptRpcArguments {
  readonly p_transport_envelope_bytes: string;
  readonly p_source_payload_bytes: string;
  readonly p_received_at_ns: string;
}

export interface FixedVisionReceiptRpcRow {
  readonly result_code: string;
  readonly result_detail: string | null;
}

export type FixedVisionReceiptRpc = (
  arguments_: FixedVisionReceiptRpcArguments
) => Promise<{
  readonly data: readonly FixedVisionReceiptRpcRow[] | null;
  readonly error: { readonly message: string } | null;
}>;

const BINDING_REJECTIONS = new Set<VisionBindingRejection>([
  "MISSING_BINDING",
  "STALE_BINDING",
  "REASSIGNED_BINDING"
]);

function byteaHex(ascii: string): string {
  return `\\x${Buffer.from(ascii, "ascii").toString("hex")}`;
}

function decodeOutcome(row: FixedVisionReceiptRpcRow): VisionPersistenceOutcome {
  if (
    !row ||
    typeof row !== "object" ||
    Object.keys(row).sort().join(",") !== "result_code,result_detail"
  ) {
    throw new Error("VISION_RECEIPT_RPC_CONTRACT: fixed RPC row fields are invalid");
  }
  if (row.result_code === "INSERTED" || row.result_code === "EXACT_RETRY") {
    if (row.result_detail !== null) {
      throw new Error("VISION_RECEIPT_RPC_CONTRACT: successful write must not carry detail");
    }
    return { kind: row.result_code };
  }
  if (row.result_code === "BINDING_REJECTED" && BINDING_REJECTIONS.has(row.result_detail as VisionBindingRejection)) {
    return { kind: "BINDING_REJECTED", reason: row.result_detail as VisionBindingRejection };
  }
  if (row.result_code === "INTEGRITY_BLOCKED" && row.result_detail) {
    return { kind: "INTEGRITY_BLOCKED", reason: row.result_detail };
  }
  if (row.result_code === "SOURCE_BLOCKED" && row.result_detail) {
    return { kind: "SOURCE_BLOCKED", reason: row.result_detail };
  }
  throw new Error("VISION_RECEIPT_RPC_CONTRACT: unsupported fixed RPC result");
}

/**
 * Adapt the one deployment-owned database operation to the pure ingest core.
 * The injected call has neither a relation name nor a destination argument.
 * Its principal is trusted to be reachable only after this process completes
 * Ed25519 verification; the database function deliberately does not duplicate
 * the Node cryptographic boundary. It must never be a dispatcher credential.
 */
export function fixedVisionReceiptPersistence(
  callFixedReceiptRpc: FixedVisionReceiptRpc
): VisionShadowReceiptPersistence {
  if (typeof callFixedReceiptRpc !== "function") {
    throw new Error("VISION_RECEIPT_RPC_CONTRACT: fixed receipt RPC is required");
  }
  return Object.freeze({
    async acceptAuthenticatedVisionReceipt(
      command: AuthenticatedVisionReceiptCommand
    ): Promise<VisionPersistenceOutcome> {
      assertAuthenticatedVisionReceiptCommand(command);
      const result = await callFixedReceiptRpc({
        p_transport_envelope_bytes: byteaHex(command.transportEnvelopeCanonicalAscii),
        p_source_payload_bytes: byteaHex(command.sourcePayloadCanonicalAscii),
        p_received_at_ns: command.receivedAtNs
      });
      if (result.error) {
        throw new Error(`VISION_RECEIPT_RPC_FAILED: ${result.error.message}`);
      }
      if (!Array.isArray(result.data) || result.data.length !== 1) {
        throw new Error("VISION_RECEIPT_RPC_CONTRACT: fixed RPC must return exactly one row");
      }
      return decodeOutcome(result.data[0]);
    }
  });
}
