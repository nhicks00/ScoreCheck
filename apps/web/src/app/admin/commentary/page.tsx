import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import {
  commentaryPortalEnabled,
  VDO_ROOM_COUNT,
  vdoDirectorUrl,
  vdoGuestRelayUrl,
  vdoGuestUrl,
  vdoRoomName,
  vdoSceneBufferMs,
  vdoSceneUrl
} from "@/lib/commentary";
import { AdminCommentaryClient } from "./AdminCommentaryClient";

export const dynamic = "force-dynamic";

export default async function AdminCommentaryPage() {
  if (!(await isAdminRequest())) redirect(`/admin/login?next=${encodeURIComponent("/admin/commentary")}`);

  const streams = Array.from({ length: VDO_ROOM_COUNT }, (_, index) => {
    const streamNumber = index + 1;
    return {
      streamNumber,
      roomName: vdoRoomName(streamNumber),
      directorUrl: vdoDirectorUrl(streamNumber),
      sceneUrl: vdoSceneUrl(streamNumber),
      guestUrl: vdoGuestUrl(streamNumber),
      guestRelayUrl: vdoGuestRelayUrl(streamNumber)
    };
  });

  return (
    <AdminCommentaryClient
      streams={streams}
      bufferMs={vdoSceneBufferMs()}
      portalEnabled={commentaryPortalEnabled()}
    />
  );
}
