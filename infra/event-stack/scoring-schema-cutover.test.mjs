import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  SCORING_MIGRATIONS,
  buildScoringSchemaCutover,
  writeScoringSchemaCutover
} from "./scoring-schema-cutover.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("builds a deterministic rollback-only 023-030 rehearsal", async () => {
  const sql = await buildScoringSchemaCutover({ mode: "rehearsal", repositoryRoot });
  assert.match(sql, /Expected production history: 022 and 029 present/);
  assert.match(sql, /poller lease is still active/);
  assert.match(sql, /rollback to savepoint scorecheck_fencing_fixture/);
  assert.match(sql, /stale lease committed/);
  assert.match(sql, /replacement lease did not commit/);
  assert.match(sql, /rollback;\n\n+do \$scorecheck_rehearsal_postflight\$/);
  assert.doesNotMatch(sql, /commit;\n\n+do \$scorecheck_applied_postflight\$/);
  let previous = -1;
  for (const [version, name] of SCORING_MIGRATIONS) {
    const marker = `-- BEGIN ${version}_${name}.sql`;
    const current = sql.indexOf(marker);
    assert.ok(current > previous, `${marker} must be in migration order`);
    assert.match(sql, new RegExp(`values \\('${version}', '${name}'`));
    previous = current;
  }
  assert.doesNotMatch(sql, /BEGIN 029_monitoring_pushover_only/);
});

test("apply output is explicit, protected, and preserves exact migration sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-schema-cutover-"));
  await mkdir(join(root, "protected"), { mode: 0o700 });
  const output = join(root, "protected", "apply.sql");
  await assert.rejects(
    () => writeScoringSchemaCutover({ mode: "apply", output }),
    /requires --acknowledge/
  );
  const result = await writeScoringSchemaCutover({
    mode: "apply",
    output,
    acknowledgement: "APPLY_SCORING_SCHEMA_023_030"
  });
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.migrations, ["023", "024", "026", "027", "028", "030"]);
  assert.equal((await stat(output)).mode & 0o077, 0);
  const sql = await readFile(output, "utf8");
  assert.match(sql, /commit;\n\n+do \$scorecheck_applied_postflight\$/);
  for (const [version, name] of SCORING_MIGRATIONS) {
    const source = await readFile(
      resolve(repositoryRoot, `apps/web/supabase/migrations/${version}_${name}.sql`),
      "utf8"
    );
    assert.ok(sql.includes(`$scorecheck_migration_${version}$${source}$scorecheck_migration_${version}$`));
  }
});

test("refuses weak output directories and existing outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-schema-cutover-weak-"));
  await chmod(root, 0o755);
  await assert.rejects(
    () => writeScoringSchemaCutover({ mode: "rehearsal", output: join(root, "rehearsal.sql") }),
    /mode 0700/
  );
  await mkdir(join(root, "protected"), { mode: 0o700 });
  const output = join(root, "protected", "rehearsal.sql");
  await writeScoringSchemaCutover({ mode: "rehearsal", output });
  await assert.rejects(
    () => writeScoringSchemaCutover({ mode: "rehearsal", output }),
    /already exists/
  );
});

test("operations documentation prohibits a migration-030-only cutover", async () => {
  const architecture = await readFile(
    resolve(repositoryRoot, "docs/ARCHITECTURE_PRODUCTION_QUALIFICATION.md"),
    "utf8"
  );
  const lifecycle = await readFile(
    resolve(repositoryRoot, "docs/EVENT_INFRASTRUCTURE_LIFECYCLE.md"),
    "utf8"
  );
  const runbook = await readFile(
    resolve(repositoryRoot, "docs/SCORING_SCHEMA_HARDCUTOVER_023_030.md"),
    "utf8"
  );
  for (const document of [architecture, lifecycle, runbook]) {
    assert.match(document, /023.*024.*026.*027.*028.*030/s);
    assert.match(document, /Applying only `030`|Never apply `030` alone|Applying only `030` is invalid/i);
  }
  assert.match(runbook, /rollback-only rehearsal/i);
  assert.match(runbook, /APPLY_SCORING_SCHEMA_023_030/);
});
