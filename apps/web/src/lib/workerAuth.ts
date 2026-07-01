import crypto from "node:crypto";

export type WorkerSecretCheck =
  | { ok: true }
  | { ok: false; message: string; status: 401 | 503 };

export function checkWorkerSecret(configuredSecret: string, providedSecret: string | null): WorkerSecretCheck {
  if (!configuredSecret) {
    return { ok: false, message: "Worker secret is not configured", status: 503 };
  }
  if (!providedSecret || !timingSafeEqual(configuredSecret, providedSecret)) {
    return { ok: false, message: "Unauthorized", status: 401 };
  }
  return { ok: true };
}

function timingSafeEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}
