import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  communityDeviceCookie,
  communityDeviceCookieOptions,
  deviceIdFromCookieOrCreate,
  requestIpHash
} from "@/lib/security";
import {
  communitySessionCookie,
  communitySessionCookieOptions,
  consumeCommunityAdmissionQuota,
  joinCommunity,
  releaseCommunitySession
} from "@/lib/communityWitness";
import { communityApiError } from "@/lib/communityHttp";
import { joinCommunitySchema } from "@/lib/communityWitnessSchemas";

export async function POST(req: NextRequest) {
  const device = deviceIdFromCookieOrCreate(req);
  const ipHash = requestIpHash(req);
  const respond = (response: NextResponse) => {
    response.cookies.set(communityDeviceCookie, device.raw, communityDeviceCookieOptions);
    return response;
  };

  if (!checkRateLimit(`community-join:${ipHash}`, 600, 60_000)) {
    return respond(NextResponse.json({ error: "Too many join attempts. Try again shortly." }, { status: 429 }));
  }
  try {
    const parsed = joinCommunitySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return respond(NextResponse.json({ error: "Invalid community join request" }, { status: 400 }));
    }
    const quota = await consumeCommunityAdmissionQuota({
      deviceTokenHash: device.hash,
      ipHash
    });
    if (!quota.allowed) {
      const message = quota.reason === "NETWORK_RATE_LIMIT"
        ? "This venue is receiving too many join attempts. Try again shortly."
        : "Too many join attempts from this device. Try again in a few minutes.";
      return respond(NextResponse.json({ error: message, code: quota.reason }, { status: 429 }));
    }
    const previousToken = req.cookies.get(communitySessionCookie)?.value ?? null;
    const { sessionToken, response } = await joinCommunity(parsed.data, {
      deviceTokenHash: device.hash
    });
    if (previousToken && previousToken !== sessionToken) {
      await releaseCommunitySession({
        sessionToken: previousToken,
        clientActionId: crypto.randomUUID()
      }).catch(() => undefined);
    }
    const next = NextResponse.json(response, { status: 201 });
    next.cookies.set(communitySessionCookie, sessionToken, communitySessionCookieOptions);
    return respond(next);
  } catch (error) {
    return respond(communityApiError(error));
  }
}
