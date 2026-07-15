import { NextRequest, NextResponse } from "next/server";
import {
  communitySessionCookie,
  communitySessionCookieOptions,
  releaseCommunitySession
} from "@/lib/communityWitness";
import { communityApiError, communityToken } from "@/lib/communityHttp";
import { releaseCommunitySchema } from "@/lib/communityWitnessSchemas";

export async function POST(req: NextRequest) {
  const token = communityToken(req);
  if (!token) return NextResponse.json({ error: "Community session not found" }, { status: 401 });
  try {
    const parsed = releaseCommunitySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid release request" }, { status: 400 });
    const response = NextResponse.json(await releaseCommunitySession({ sessionToken: token, ...parsed.data }));
    response.cookies.set(communitySessionCookie, "", { ...communitySessionCookieOptions, maxAge: 0 });
    return response;
  } catch (error) {
    return communityApiError(error);
  }
}
