import { createHmac, randomUUID } from "node:crypto";
import { MONITORING_CONTRACT_VERSION } from "./monitoringContract";

const CREDENTIAL_TTL_MS = 18 * 60 * 60 * 1_000;

export type ProgramMonitoringConnection = {
  heartbeatUrl: string;
  thumbnailUrl: string;
  credential: string;
  credentialId: string;
};

export function createProgramMonitoringConnection(
  courtNumber: number,
  options: { nowMs?: number; credentialId?: string } = {}
): ProgramMonitoringConnection | null {
  const baseUrl = process.env.MONITOR_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
  const secret = process.env.MONITOR_BROWSER_HEARTBEAT_SECRET?.trim() ?? "";
  if (!baseUrl || secret.length < 32) return null;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  const localHttp = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !localHttp) return null;
  if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > 8) return null;

  const nowMs = options.nowMs ?? Date.now();
  const credentialId = options.credentialId ?? randomUUID();
  const encoded = Buffer.from(JSON.stringify({
    v: MONITORING_CONTRACT_VERSION,
    cid: credentialId,
    court: courtNumber,
    iat: nowMs,
    exp: nowMs + CREDENTIAL_TTL_MS
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return {
    heartbeatUrl: `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}/v1/browser-heartbeats`,
    thumbnailUrl: `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}/v1/browser-thumbnails`,
    credential: `${encoded}.${signature}`,
    credentialId
  };
}
