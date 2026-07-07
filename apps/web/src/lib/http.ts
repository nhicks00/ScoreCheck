import { NextResponse } from "next/server";

// Oversized or malformed bodies resolve to {} so route-level validation
// returns a 400 instead of an unhandled 500.
const MAX_BODY_BYTES = 64 * 1024;

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function readFormOrJson(req: Request): Promise<Record<string, string>> {
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return {};
  }
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) {
        return {};
      }
      const body: unknown = raw ? JSON.parse(raw) : {};
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return {};
      }
      return Object.fromEntries(
        Object.entries(body).map(([key, value]) => [key, value == null ? "" : String(value)])
      );
    }
    const form = await req.formData();
    return Object.fromEntries(Array.from(form.entries()).map(([key, value]) => [key, String(value)]));
  } catch {
    return {};
  }
}
