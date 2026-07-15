import { describe, expect, it } from "vitest";
import { canAutoApplyCommunityDispute, classifyCommunityDispute } from "../lib/communityDisputePolicy";

describe("community dispute resolution policy", () => {
  it.each(["ADD_POINT", "REMOVE_POINT"])("never reapplies an already canonical %s action", (commandType) => {
    const dispute = classifyCommunityDispute(commandType, true);
    expect(dispute).toEqual({
      resolutionKind: "POST_CANONICAL_DISSENT",
      alreadyApplied: true,
      proposalEligible: false
    });
    expect(canAutoApplyCommunityDispute(dispute)).toBe(false);
  });

  it("allows one-click application only for a strict-majority unapplied proposal", () => {
    const dispute = classifyCommunityDispute("AUTHORITY_CHANGE", true);
    expect(dispute).toEqual({
      resolutionKind: "UNAPPLIED_MAJORITY_PROPOSAL",
      alreadyApplied: false,
      proposalEligible: true
    });
    expect(canAutoApplyCommunityDispute(dispute)).toBe(true);
  });

  it("never promotes a tied or no-majority proposal to an admin suggestion", () => {
    const dispute = classifyCommunityDispute("AUTHORITY_CHANGE", false);
    expect(dispute).toEqual({
      resolutionKind: "NO_CONSENSUS_REVIEW",
      alreadyApplied: false,
      proposalEligible: false
    });
    expect(canAutoApplyCommunityDispute(dispute)).toBe(false);
  });

  it("fails closed when the linked canonical event is missing", () => {
    const dispute = classifyCommunityDispute(null, true);
    expect(dispute).toEqual({
      resolutionKind: "POST_CANONICAL_DISSENT",
      alreadyApplied: true,
      proposalEligible: false
    });
    expect(canAutoApplyCommunityDispute(dispute)).toBe(false);
  });

  it("fails closed when discriminator fields disagree", () => {
    expect(canAutoApplyCommunityDispute({
      resolutionKind: "UNAPPLIED_MAJORITY_PROPOSAL",
      alreadyApplied: true,
      proposalEligible: true
    })).toBe(false);
  });
});
