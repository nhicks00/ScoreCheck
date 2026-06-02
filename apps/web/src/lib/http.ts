import { NextResponse } from "next/server";

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function readFormOrJson(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await req.json();
    return Object.fromEntries(
      Object.entries(body ?? {}).map(([key, value]) => [key, value == null ? "" : String(value)])
    );
  }
  const form = await req.formData();
  return Object.fromEntries(Array.from(form.entries()).map(([key, value]) => [key, String(value)]));
}
