# Readiness V2 label-pack gate

The readiness manifest is hard-cut to schema `2.0`; schema `1.0` and omitted V2
fields are blockers. The readiness report is hard-cut to schema `3.0`. Neither
contract has a compatibility alias or an old-schema parser.

For each source, `labels_sha256` now means exactly the raw SHA-256 of a
`BallLabelPackRootV1`. It no longer means a loose label file or an object in the
media/capture artifact generation. Every source also carries the exact
`label_pack_generation_id`. The source record, rights proof, and structural
label-pack proof all bind this tuple:

```text
(source_id, asset_sha256, labels_sha256,
 label_pack_generation_id, TRAIN|DEV|TEST)
```

The validator requires one unique rights proof and one unique label-pack proof
for every source. Complete proof sets must have identical source IDs and exact
tuple values. The label-pack proof additionally commits the reconstructed
statement, curator attestation, curator trust snapshot, annotation-attestation
set, contract-object count, and verified contract-byte count.

## Separate stores

The CLI requires two distinct protected roots:

- `--artifact-store-root` contains source media plus calibration, camera,
  clock, and encoder evidence only; and
- `--label-store-root` contains exact causal-ball label-pack generations only.

Lexical aliases and symlinks resolving both arguments to the same root are
rejected. Label-pack root and closure hashes are absent from
`artifact_set_proof`. A media/capture digest may not overlap any pack contract
closure. Across label generations, a contract digest may repeat only when it
is the curator-trust-snapshot object in every occurrence; reuse in any other
typed role fails closed. Curator snapshot reuse is not itself a reason to
reject different source-bound generations.

## One bounded worker

After the signed manifest, full TRAIN/DEV/TEST split contract, source shape,
lineage, and cheap bounds pass, one killable `spawn` worker verifies the entire
label-pack batch. It receives only the label-store root, bounded source tuples,
and the sorted media/capture digest set. It opens packs sequentially through
`load_ball_label_pack`; the parent never accepts preconstructed pack proofs.

Fixed limits are:

| Boundary | Limit |
| --- | ---: |
| Sources / pack requests / compact proofs | 512 |
| Verified contract objects across the batch | 1,000,000 |
| Verified contract bytes across the batch | 4 GiB |
| Post-start parent/worker monotonic verification/result deadline | 3,600 seconds |
| Per-pack limits | 20,000 objects / 256 MiB |

Descriptor cardinality is preflighted before staging the next pack. Because an
immutable descriptor does not carry byte sizes, the worker reserves one full
per-pack 256 MiB budget before another load; verified work cannot cross the
advertised 4 GiB cap. Process construction and spawn bootstrap are separate
fail-closed setup steps; the fixed deadline begins immediately after
`Process.start()` returns. Worker results use a bounded length-prefixed strict
canonical-JSON frame drained from a nonblocking pipe descriptor against that
same deadline—never pickle or a blocking `recv()`. Timeout, worker exit, IPC
schema, store, and pack errors become stable blockers. Cleanup is best-effort
but always attempts terminate, then kill, and cannot be skipped by a failing
pipe/process close operation.

The protected configuration generation is reread after all work. A concurrent
policy, trust, revocation, current-manifest, deployment, or configuration
publication discards the result. A completion-date rollover may repeat
date-governed trust and rights verification, but never reloads label packs.

## Structural evidence is not admission

The report serializes all five admission scopes as exact `false` values:

- training;
- evaluation;
- test;
- deployment; and
- live scoring.

That remains true for structurally valid `TRAIN`, `DEV`, and `TEST` packs.
`ready=true` means this bounded intake evidence is internally consistent under
the current protected readiness boundary. It does not authorize a trainer,
expose TEST labels to training, establish semantic truth, prove pixels or
rights, authorize deployment, or mutate a score. A later trusted training-run
coordinator must reverify current authorities and issue a narrower immutable
TRAIN/DEV job generation while keeping TEST evaluation-only.

## Synthetic fixture regeneration

From `vision_scoring/`, regenerate all three TRAIN/DEV/TEST pack generations,
the reduced media/capture artifact generation, signed manifest, current/revoked
manifest store, policy pins, rotated synthetic launcher artifact, and protected
configuration generation with:

```bash
.venv/bin/python scripts/regenerate_readiness_fixtures.py
```

The script places the checked-out `src/` tree ahead of installed packages and
is deterministic and idempotent. Its keys, content, decisions, and trust stores
are explicit synthetic smoke fixtures only; they are not production roots or
trainable beach-volleyball data.
