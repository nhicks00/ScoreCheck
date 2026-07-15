export type CommunityDisputeResolutionKind =
  | "POST_CANONICAL_DISSENT"
  | "UNAPPLIED_MAJORITY_PROPOSAL"
  | "NO_CONSENSUS_REVIEW";

export function classifyCommunityDispute(linkedCommandType: unknown, proposalEligible = false): {
  resolutionKind: CommunityDisputeResolutionKind;
  alreadyApplied: boolean;
  proposalEligible: boolean;
} {
  if (linkedCommandType === "AUTHORITY_CHANGE") {
    return {
      resolutionKind: proposalEligible ? "UNAPPLIED_MAJORITY_PROPOSAL" : "NO_CONSENSUS_REVIEW",
      alreadyApplied: false,
      proposalEligible: proposalEligible === true
    };
  }
  return {
    resolutionKind: "POST_CANONICAL_DISSENT",
    alreadyApplied: true,
    proposalEligible: false
  };
}

export function canAutoApplyCommunityDispute(input: {
  resolutionKind: CommunityDisputeResolutionKind;
  alreadyApplied: boolean;
  proposalEligible?: boolean;
}): boolean {
  return input.resolutionKind === "UNAPPLIED_MAJORITY_PROPOSAL"
    && input.alreadyApplied === false
    && input.proposalEligible === true;
}
