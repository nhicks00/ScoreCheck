export type RequestedCommunityRole = "OBSERVER" | "DESIGNATED_SCORER";

export function requestedCommunityRole(joinCode: string | undefined, roleIntent: string | undefined): RequestedCommunityRole {
  return joinCode?.trim() && roleIntent?.toLowerCase() === "designated" ? "DESIGNATED_SCORER" : "OBSERVER";
}
