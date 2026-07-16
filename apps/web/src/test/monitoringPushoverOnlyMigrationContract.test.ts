import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/029_monitoring_pushover_only.sql"),
  "utf8"
);

describe("monitoring Pushover-only migration contract", () => {
  it("fails closed when incompatible notification history exists", () => {
    expect(migration).toContain("where provider <> 'pushover'");
    expect(migration).toContain("raise exception using");
    expect(migration).not.toMatch(/delete\s+from\s+public\.incident_notifications/i);
    expect(migration).not.toMatch(/update\s+public\.incident_notifications/i);
  });

  it("hard-cuts the provider constraint to Pushover", () => {
    expect(migration).toContain("drop constraint if exists incident_notifications_provider_check");
    expect(migration).toContain("add constraint incident_notifications_provider_check");
    expect(migration).toContain("check (provider = 'pushover')");
    expect(migration).not.toContain("twilio_sms");
    expect(migration).not.toContain("twilio_voice");
    expect(migration).not.toContain("'external'");
  });
});
