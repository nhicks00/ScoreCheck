import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(process.cwd(), "supabase/migrations/032_program_hls_transport_hardcut.sql"),
  "utf8"
);

describe("program HLS transport hard cut", () => {
  it("removes obsolete source-delay accounting without changing commentary fallback", () => {
    expect(migration).toContain("alter column program_video_delay_ms set default 0");
    expect(migration).toContain("set program_video_delay_ms = 0");
    expect(migration).not.toContain("commentary_delay_ms");
  });
});
