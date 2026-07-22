import { isAbsolute } from "node:path";

import { withProcessLock } from "./process-lock.mjs";

export function withQualificationGateLock({ profile, lifecycleState, gate }, operation) {
  if (!profile || typeof profile.state !== "string" || !isAbsolute(profile.state)) {
    throw new Error("qualification gate requires an absolute lifecycle state path");
  }
  if (!lifecycleState || typeof lifecycleState.event !== "string" || !lifecycleState.event) {
    throw new Error("qualification gate event identity is missing");
  }
  if (typeof lifecycleState.generationId !== "string" || !lifecycleState.generationId) {
    throw new Error("qualification gate generation identity is missing");
  }
  if (typeof gate !== "string" || !gate) throw new Error("qualification gate label is missing");
  if (typeof operation !== "function") throw new Error("qualification gate operation is missing");

  return withProcessLock(
    {
      lockPath: `${profile.state}.qualification-gate.lock`,
      label: `${lifecycleState.event}/${lifecycleState.generationId} ${gate}`
    },
    operation
  );
}
