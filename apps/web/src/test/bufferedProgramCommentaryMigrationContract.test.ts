import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(process.cwd(), "supabase/migrations/031_buffered_program_commentary_timing.sql"),
  "utf8"
);

describe("buffered program commentary timing migration", () => {
  it("widens only runtime heartbeat delay evidence to the 30 second audio-graph bound", () => {
    expect(migration).toContain("program_heartbeats_commentary_delay_configured_ms_check");
    expect(migration).toContain("program_heartbeats_commentary_delay_target_ms_check");
    expect(migration).toContain("program_heartbeats_commentary_delay_applied_ms_check");
    expect(migration.match(/between 0 and 30000/g)).toHaveLength(3);
    expect(migration).not.toContain("alter table public.courts");
  });
});
