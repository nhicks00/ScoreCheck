import crypto from "node:crypto";
import { NextRequest } from "next/server";

const TOKEN_BYTES = 24;

export function generateScorerToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashSecret(value: string): string {
  return crypto.createHash("sha256").update(`mcs:v1:${value}`).digest("hex");
}

export function constantTimeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function validateToken(rawToken: string | null | undefined, expectedHash: string | null | undefined): boolean {
  if (!rawToken || !expectedHash) return false;
  return constantTimeEqual(hashSecret(rawToken), expectedHash);
}

export function requestIpHash(req: NextRequest): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
  return hashSecret(ip);
}

export function userAgent(req: NextRequest): string {
  return req.headers.get("user-agent")?.slice(0, 500) ?? "unknown";
}
