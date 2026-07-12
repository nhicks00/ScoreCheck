import crypto from "node:crypto";
import type { RequestHandler } from "express";

export function bearerAuth(expectedToken: string): RequestHandler {
  return (req, res, next) => {
    const header = req.header("authorization");
    const actual = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!constantTimeEqual(actual, expectedToken)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}

export function constantTimeEqual(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function safeMetricLabel(value: string): string | null {
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_.:-]{1,80}$/.test(trimmed) ? trimmed : null;
}
