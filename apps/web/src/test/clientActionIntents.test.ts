import { describe, expect, it, vi } from "vitest";
import { clientIntentKey, createClientActionIntentRegistry } from "../lib/clientActionIntents";

describe("admin client action intents", () => {
  it("reuses the same action ID after failure and rotates only after success", () => {
    const createId = vi.fn()
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    const registry = createClientActionIntentRegistry(createId);
    const key = clientIntentKey("admin-point", { courtId: "court-1", action: "point-a" });

    const first = registry.actionIdFor(key);
    expect(registry.actionIdFor(key)).toBe(first);
    expect(createId).toHaveBeenCalledTimes(1);

    registry.complete(key, first);
    expect(registry.actionIdFor(key)).toBe("22222222-2222-4222-8222-222222222222");
    expect(createId).toHaveBeenCalledTimes(2);
  });

  it("scopes retry keys to canonical payload content independent of key order", () => {
    expect(clientIntentKey("assign", { courtId: "c1", matchId: "m2" }))
      .toBe(clientIntentKey("assign", { matchId: "m2", courtId: "c1" }));
    expect(clientIntentKey("assign", { courtId: "c1", matchId: "m2" }))
      .not.toBe(clientIntentKey("assign", { courtId: "c1", matchId: "m3" }));
  });
});
