import { NextResponse } from "next/server";
import { getActiveEvent } from "@/lib/eventConfig";
import { missingEnvKeys } from "@/lib/env";

export async function GET() {
  try {
    if (missingEnvKeys().some((key) => key.startsWith("NEXT_PUBLIC_SUPABASE") || key === "SUPABASE_SERVICE_ROLE_KEY")) {
      return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
    }
    const event = await getActiveEvent();
    if (!event) return NextResponse.json({ error: "No active event" }, { status: 404 });
    return NextResponse.json({ event }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not load current event" }, { status: 500 });
  }
}
