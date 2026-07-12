import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import {
  commentaryLiveKitConfigured,
  commentaryPortalEnabled,
  COMMENTARY_ROOM_COUNT,
  commentaryRoomName
} from "@/lib/commentary";
import { publicOrigin } from "@/lib/env";
import { AdminCommentaryClient } from "./AdminCommentaryClient";

export const dynamic = "force-dynamic";

export default async function AdminCommentaryPage() {
  if (!(await isAdminRequest())) redirect(`/admin/login?next=${encodeURIComponent("/admin/commentary")}`);

  const streams = Array.from({ length: COMMENTARY_ROOM_COUNT }, (_, index) => {
    const streamNumber = index + 1;
    return {
      streamNumber,
      roomName: commentaryRoomName(streamNumber),
      commentatorUrl: `${publicOrigin()}/commentary/court/${streamNumber}`
    };
  });

  return (
    <AdminCommentaryClient
      streams={streams}
      portalEnabled={commentaryPortalEnabled()}
      liveKitConfigured={commentaryLiveKitConfigured()}
    />
  );
}
