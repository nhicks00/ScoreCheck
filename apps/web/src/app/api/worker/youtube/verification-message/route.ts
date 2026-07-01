import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { verifyClaimFromYoutubeMessage } from "@/lib/scorerSessions";
import { checkWorkerSecret } from "@/lib/workerAuth";

const schema = z.object({
  liveChatId: z.string().min(1),
  messageId: z.string().min(1),
  messageText: z.string().max(500),
  author: z.object({
    channelId: z.string().optional(),
    displayName: z.string().optional(),
    profileImageUrl: z.string().optional(),
    isChatOwner: z.boolean().optional(),
    isChatModerator: z.boolean().optional(),
    isChatSponsor: z.boolean().optional(),
    isVerified: z.boolean().optional()
  }),
  publishedAt: z.string().optional()
});

export async function POST(req: NextRequest) {
  const env = getEnv();
  const secretCheck = checkWorkerSecret(env.youtubeWorkerSharedSecret, req.headers.get("x-worker-secret"));
  if (!secretCheck.ok) {
    return NextResponse.json({ error: secretCheck.message }, { status: secretCheck.status });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid worker message" }, { status: 400 });
  const result = await verifyClaimFromYoutubeMessage(parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json(result);
}
