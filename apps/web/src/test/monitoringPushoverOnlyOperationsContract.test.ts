import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "../..");
const verifySql = readFileSync(
  join(repoRoot, "infra/monitoring/sql/verify-pushover-only.sql"),
  "utf8"
);
const rollbackSql = readFileSync(
  join(repoRoot, "infra/monitoring/sql/rollback-pushover-only.sql"),
  "utf8"
);

describe("monitoring Pushover-only operational SQL", () => {
  it("verifies the exact ledger entry and rejects non-Pushover providers transactionally", () => {
    expect(verifySql).toContain("version = '029'");
    expect(verifySql).toContain("name = 'monitoring_pushover_only'");
    expect(verifySql).toContain("where provider <> 'pushover'");
    expect(verifySql).toContain("like public.incident_notifications including defaults including constraints");
    expect(verifySql).toContain("exception when check_violation");
    expect(verifySql).toContain("rollback;");
    expect(verifySql).not.toMatch(/delete\s+from\s+public\.incident_notifications/i);
    expect(verifySql).not.toMatch(/update\s+public\.incident_notifications/i);
  });

  it("guards rollback and restores the former constraint without rewriting history", () => {
    expect(rollbackSql).toContain("migration version 029 has a different name");
    expect(rollbackSql).toContain("migration 029 is not applied");
    expect(rollbackSql).toContain("current constraint accepts a non-Pushover provider");
    expect(rollbackSql).toContain("drop constraint if exists incident_notifications_provider_check");
    expect(rollbackSql).toContain("'twilio_sms'");
    expect(rollbackSql).toContain("'twilio_voice'");
    expect(rollbackSql).toContain("'external'");
    expect(rollbackSql).toContain("delete from supabase_migrations.schema_migrations");
    expect(rollbackSql).not.toMatch(/delete\s+from\s+public\.incident_notifications/i);
    expect(rollbackSql).not.toMatch(/update\s+public\.incident_notifications/i);
  });
});
