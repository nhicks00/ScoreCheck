import type {
  CommunitySessionSnapshot,
  ContributionActionType,
  TeamSide
} from "./communityWitnessUi";

export type PendingContribution = {
  clientActionId: string;
  kind: "observation" | "command";
  type: ContributionActionType;
  team: TeamSide;
  baseRevision: number;
  rallyNumber: number;
  deviceSequence: number;
  createdAt: string;
};

export class CommunityApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "CommunityApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

export async function getCommunitySession(signal?: AbortSignal): Promise<CommunitySessionSnapshot> {
  return requestSnapshot("/api/community/session", { method: "GET", cache: "no-store", signal });
}

export async function renewCommunityLease(): Promise<CommunitySessionSnapshot> {
  return requestSnapshot("/api/community/session/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
}

export async function submitPendingContribution(pending: PendingContribution): Promise<CommunitySessionSnapshot> {
  if (pending.kind === "observation") {
    return requestSnapshot("/api/community/session/observations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientActionId: pending.clientActionId,
        baseRevision: pending.baseRevision,
        observation: { type: pending.type, team: pending.team },
        deviceSequence: pending.deviceSequence
      })
    });
  }

  return requestSnapshot("/api/community/session/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientActionId: pending.clientActionId,
      expectedRevision: pending.baseRevision,
      action: { type: pending.type, team: pending.team }
    })
  });
}

export async function releaseCommunitySession(clientActionId: string): Promise<CommunitySessionSnapshot> {
  return requestSnapshot("/api/community/session/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientActionId })
  });
}

export function parsePendingContribution(raw: string | null): PendingContribution | null {
  if (!raw) return null;
  try {
    const input = JSON.parse(raw) as Partial<PendingContribution>;
    if (
      typeof input.clientActionId === "string"
      && (input.kind === "observation" || input.kind === "command")
      && (input.type === "ADD_POINT" || input.type === "REMOVE_POINT")
      && (input.team === "A" || input.team === "B")
      && Number.isInteger(input.baseRevision)
      && Number(input.baseRevision) >= 0
      && Number.isInteger(input.rallyNumber)
      && Number(input.rallyNumber) >= 0
      && Number.isInteger(input.deviceSequence)
      && Number(input.deviceSequence) >= 0
      && typeof input.createdAt === "string"
    ) {
      return input as PendingContribution;
    }
  } catch {
    // Ignore corrupt device-local retry state.
  }
  return null;
}

async function requestSnapshot(url: string, init: RequestInit): Promise<CommunitySessionSnapshot> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new CommunityApiError("Could not reach community scoring.", 0, true);
  }

  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok !== true) {
    const message = friendlyApiError(typeof json.error === "string" ? json.error : null, response.status);
    throw new CommunityApiError(message, response.status, response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500);
  }
  return json as CommunitySessionSnapshot;
}

function friendlyApiError(message: string | null, status: number): string {
  if (status === 401 || status === 403 || status === 404 || status === 410) return "This community scoring session is no longer active.";
  if (status === 409) return message || "The broadcast score changed first. Your screen has been refreshed.";
  if (!message || /api key|supabase|service role|jwt|database/i.test(message)) {
    return "Community scoring is not ready yet. Please try again in a moment.";
  }
  return message;
}
