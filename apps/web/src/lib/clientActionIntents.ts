export type ClientActionIntentRegistry = {
  actionIdFor: (intentKey: string) => string;
  complete: (intentKey: string, actionId: string) => void;
  pendingActionId: (intentKey: string) => string | null;
};

/**
 * Retains an action ID while a user intent is unresolved. A lost response or
 * explicit retry therefore reaches the server with the original idempotency
 * key; successful completion clears it so the next click is a new intent.
 */
export function createClientActionIntentRegistry(
  createActionId: () => string = () => crypto.randomUUID()
): ClientActionIntentRegistry {
  const pending = new Map<string, string>();
  return {
    actionIdFor(intentKey) {
      const existing = pending.get(intentKey);
      if (existing) return existing;
      const actionId = createActionId();
      pending.set(intentKey, actionId);
      return actionId;
    },
    complete(intentKey, actionId) {
      if (pending.get(intentKey) === actionId) pending.delete(intentKey);
    },
    pendingActionId(intentKey) {
      return pending.get(intentKey) ?? null;
    }
  };
}

export function clientIntentKey(scope: string, payload: Record<string, unknown> = {}) {
  return `${scope}:${stableSerialize(payload)}`;
}

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}
