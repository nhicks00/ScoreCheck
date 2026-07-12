# Vision Scoring Foundation

This package is the hard-cutover foundation for assistive beach-volleyball
scoring. It intentionally contains no detector, tracker, or model runtime yet.

Architecture and readiness decisions live in
[the vision-scoring documentation](../docs/vision-scoring/ARCHITECTURE.md).

The adopted V0 boundary is explicit:

1. perception creates immutable observations;
2. causal fusion creates a bounded `RallyHypothesis` from primary rally
   evidence, with no policy or scoring power;
3. a separately timed next-server observation may be reconciled against that
   hypothesis, but can only corroborate it or make the result less eligible;
4. exception-first policy creates a reproducible `PolicyAssessment`, which is
   advice and never an authorization;
5. an authenticated human signs an exact `AuthorizationCommand`, either
   directly or with a separately signed eligible assessment attached;
6. a trusted authorizer verifies the protected per-match policy, human role,
   signatures, assessment provenance, context, and event, then countersigns an
   `AuthorizedRuleEvent` envelope;
7. a transactional shadow processor must reverify that envelope, replay the
   immutable log, call `RulesReducer.reduce()`, and atomically append the event
   and derived state.

There is no model or service principal that can authorize a score in V0. The
only trusted actor roles are `SCOREKEEPER`, `REFEREE`, and `MATCH_ADMIN`, and
the last role may seed a set only. Assessment assistance never replaces the
human signature.

The reducer is **not** an access-control or security boundary. A `RuleEvent`
contains domain facts only: no actor, role, permission claim, authorization
identifier, or signature. The signed envelope is the security boundary, and
durable use additionally requires transactional verification and append. Do
not expose the reducer directly to untrusted input or use its acceptance of an
event as proof that the event was authorized.

Create the locked Python 3.11 environment and run the unit tests:

```bash
uv sync --locked --python 3.11
uv run --locked python -m unittest discover -s tests -v
```

Validate a capture/data readiness manifest:

```bash
uv run --locked python -m vision_scoring.readiness \
  examples/readiness-manifest.json \
  --dataset-trust-store examples/dataset-trust-store.json \
  --dataset-manifest-attestation examples/dataset-manifest-attestation.json \
  --readiness-verification-policy examples/readiness-verification-policy.json \
  --expected-readiness-verification-policy-sha256 \
    77dc5aeafc6f4c3697ad545456545639f736009838288c2dd37f29e49866577a \
  --trusted-launcher-deployment-artifact-sha256 \
    ada0689d8c632e1ec54c0d97bd5428afc6875b6d36fe6f363d3e12c0b81dda38 \
  --expected-governance-domain-id example-dataset-governance \
  --protected-configuration-generation \
    examples/protected-configuration-generation.json \
  --artifact-store-root examples/dataset-artifacts \
  --rights-trust-store examples/rights-trust-store.json \
  --rights-verification-policy examples/rights-verification-policy.json \
  --expected-rights-verification-policy-sha256 \
    e4e87616222b632a36f6d2aed1e76e92ce27bf04c3c1c0f34677df448754ffde \
  --rights-evidence-store-root examples/rights-evidence
```

This checked-in policy is a host-specific synthetic smoke fixture: its runtime
pin includes the exact Python compiler/version, cryptography/OpenSSL versions,
machine, OS, and OS release on the generating host. Run the command only on a
matching locked runtime, or publish a new trusted fixture generation with pins
computed for the target deployment. Do not rewrite pins inside an untrusted
dataset job merely to make the example pass.

The checked-in media/label placeholders, trust stores, signatures, decisions,
hashes, and evidence are synthetic structural examples only. They are
intentionally not production media or trust anchors. A production launcher must
independently pin the readiness-policy fingerprint, deployment artifact,
runtime identity, governance domain, rights policy, and trust stores; those
values cannot come from the dataset. The signed manifest cannot disable the
unseen-TEST-venue rule. Validation uses one detached canonical manifest
snapshot and a fresh UTC trust check, then resolves and hashes every declared
media, label, calibration, camera-attestation, clock-verification, and encoder
artifact from a separately supplied immutable content-addressed generation.
Source rights are verified for currentness and signature first, then their
deduplicated evidence union is checked in one bounded worker and one immutable
generation lease. DEV as well as TRAIN requires deployment permission because
tuning/model selection influences the shipped model.

`ManifestValidator` is deliberately single-use. The trusted launcher freshly
loads one protected configuration generation for every invocation, and the
validator reopens that current-generation descriptor after all artifact work.
If a policy, current-manifest store, rights decision store, key compromise, or
revocation generation is published during the run, the result is discarded and
must be retried. The trusted publisher must serialize generations and forbid
rollback; an external monotonic release sequence is required if rollback/ABA is
in the threat model.

Artifact and evidence stores use
`locks/<generation-id>.lock` plus
`generations/<generation-id>/{descriptor.json,objects/<sha256>}`. The publisher
creates and fsyncs a private generation, bootstraps the lock, takes the
exclusive writer lease, and atomically publishes the directory. Published
generations are never modified. Readers have read-only filesystem access and
hold one shared lease for the complete batch; every object is safely opened,
hashed, and staged before its bytes are exposed. `flock` is cooperative, so a
process that can ignore it and write the protected store is a deployment-boundary
compromise. Production should separate publisher and consumer UIDs and prefer a
read-only APFS snapshot/mount where available.

The verifier source-tree digest is accurately labeled as source integrity, not
as proof of loaded code. Executable provenance is an outer deployment boundary:
the protected policy also pins a deployment artifact digest supplied by the
trusted launcher and the exact Python/cryptography/OpenSSL/runtime identity.
The CLI assumes its invoker, these pins, and the clock are trusted governance
inputs; never expose them as dataset-controlled job options.

The readiness JSON is a canonical, content-addressed proof report, not a signed
authorization token. It carries the signed-manifest proof, artifact sizes/set
fingerprint and generation ID, rights-evidence generation ID, protected
configuration generation, protected policies, runtime/deployment commitments,
exact source-rights uses, review and expiry dates, and verification time. A
training job must recompute it in-process instead of trusting uploaded report
JSON, then reacquire the same generation and independently stage/hash each
object as it is consumed. Model cards retain that lineage, and
deployment/continued operation revalidate it
under the then-current stores and policies; passing a pre-training
`MODEL_DEPLOYMENT` check never permanently authorizes a later release.

`ready=true` is the capture/data-intake gate, not permission to start an
arbitrary trainer and not evidence that label semantics are correct. A training
or evaluation entry point must additionally parse the exact label artifact into
the strict annotation contracts, verify the current detached signature from
every declared reviewer/adjudicator and all resident review evidence under its
independently pinned annotation policy, require a launcher-owned protected
annotation-configuration pointer, and recheck that generation after evidence
work. The evaluation report binds the exact trust store, policy, evaluator,
governance domain, evidence generation, and protected configuration generation.
It also enforces its task-specific coverage manifest. The checked-in label files
are deliberately synthetic placeholders; they demonstrate content addressing
only and are not trainable truth.

Create a conservative technical inventory for one or more resident local media
files (the Python module is standard-library-only; `ffprobe` must be installed
as a system executable):

```bash
PYTHONPATH=src python3 -m vision_scoring.media_preflight match-a.mov match-b.mp4
```

After installing the package, the equivalent entry point is
`vision-scoring-media-preflight`.

A report accepts at most 256 sources; larger inventories must be processed in
batches so report memory and output remain bounded. ffprobe scalar facts are
limited to 4,096 characters, normalized items to 512 KiB each, and the complete
canonical report to 16 MiB. A size violation fails closed and discards affected
probe facts rather than emitting an unbounded report.

Every media item remains `QUARANTINED`. The media schema never emits an
authoritative rights status: it defaults to `rights_claim.claim=NO_CLAIM`, and
every claim carries `verification=UNVERIFIED`. For one source only, a caller may
record opaque unverified rights/provenance claims without the tool opening or
verifying them:

```bash
PYTHONPATH=src python3 -m vision_scoring.media_preflight match-a.mov \
  --rights-claim CLAIMED_OWNED \
  --rights-ref internal-contract:example \
  --provenance-ref camera-export:example
```

The preflight hashes every readable source, records selected container and
stream facts, scans only the selected primary-video stream's demuxed packet
rows, and reports exact raw PTS/DTS missing, equal-to-previous, and
less-than-previous counts in ffprobe demux output order. Packet indices are
zero-based; each present timestamp is compared with the previous present
timestamp in that order. Occurrence details are retained for the first 50
ranges/events of each kind; exact counts continue after that and the
corresponding `details_truncated` fields become true. Primary
audio-minus-video duration is represented as an exact rational number of seconds
when both stream durations are available. “Exact” here means exact arithmetic
over the duration values ffprobe reports; it is not a stronger claim about the
container's underlying timing accuracy. Decimal/rational significant digits,
exponents, magnitude, bit lengths, and rendered scale are bounded before exact
arithmetic. The top-level `report_sha256` is SHA-256 over canonical UTF-8 JSON
with that checksum field omitted.

Hashing is a bounded staging transaction, not an unbounded read of the original
pathname. A worker binds a non-symlink regular-file descriptor, fixes the
initial logical byte count, rejects the source above 64 GiB by default, detects
early EOF, growth, metadata/identity change, and pathname replacement, and has a
900-second default wall-clock deadline. The limits can be reduced with
`--max-source-bytes` and `--hash-timeout-seconds`. Bytes and SHA-256 are produced
while copying once into a private content-addressed file under POSIX `/tmp`;
ffprobe sees only that read-only snapshot, which is deleted after the item.
Peak temporary storage is therefore approximately one source's logical size.
macOS `dataless` placeholders, symlinks, non-regular files, and sources that
cannot be staged within the deadline fail closed. Probe/worker subprocesses run
in isolated POSIX process groups; deadlines cover pipe EOF and final process
exit, and cleanup targets descendants as well as the group leader.

The primary video is the default-disposition, lowest-index non-attached-picture
video stream. Program membership comes from `ffprobe -show_programs`. When a
container declares programs, duration comparison uses audio only from the
unique program containing the selected video; missing or ambiguous video
program membership leaves the A/V delta unavailable. For containers with no
declared programs, the unprogrammed container is treated as one explicit
implicit scope. Every selection basis and candidate stream index is recorded in
`stream_selection`.

This is not a decode test. It cannot establish decode integrity, dropped capture
frames, visual/content duplication, rights validity, ball visibility,
calibration quality, presentation-timeline/capture-timestamp integrity, or
capture/training readiness. A PTS value moving backward in demux output order is
normal for codecs that reorder frames (including common B-frame streams); the
reported `demux_order_regression_count` must not be interpreted as a
capture-clock reversal. DTS monotonicity is a useful demux/decode-order fact but
still does not prove capture health or frame completeness. Equal timestamp
values likewise do not prove duplicate packets, frames, or content.

Metadata inspection times out after 60 seconds and the streaming packet scan
after 300 seconds. Download macOS cloud placeholders locally before preflight.

The readiness thresholds are engineering gates, not governing-body standards.

Implemented now:

- immutable frame, calibration, observation, `RallyHypothesis`, optional
  next-server reconciliation, `PolicyAssessment`, and typed rule-event
  contracts;
- deterministic set/match scoring with service-order validation;
- explicit replay/no-point plus latched side-switch and technical-timeout obligations;
- idempotent event replay and simultaneous reducer effects;
- exactly five rule-event types: `SET_SEED`, `POINT_AWARDED`,
  `REPLAY_NO_POINT`, `SIDE_SWITCH_CONFIRMED`, and
  `TECHNICAL_TIMEOUT_COMPLETED`;
- Ed25519-signed human commands, signed assessment provenance for the assisted
  path, protected per-match policy generations and current revocations, fixed
  role/event allowlists, authorizer countersignatures, and strict canonical
  authorized-event envelopes;
- canonical match-state encoding and validation for cache comparison; the
  event log, not a decoded state snapshot, remains the replay source of truth;
- detached-snapshot, curator-signed readiness manifests with current/revoked
  governance and byte-verified resident media, label, calibration, camera,
  clock, and encoder artifacts;
- signed commercial-rights decisions with batched evidence verification plus
  immutable, bounded, leakage-safe dataset splits;
- strict decoded-frame/ball/event annotation identity and signed reviewer/
  adjudicator trust;
- a deterministic ball-localization benchmark with an explicit operating
  threshold, full-ranking AP101, apparent-ball-diameter-normalized errors,
  duplicate handling, and negative-only activation metrics.

Not implemented yet:

- persistence/transactional append storage;
- deployment identity/session resolution that maps a signed human key to the
  protected per-match authorization policy;
- the scorer-copilot review workflow and shadow outbox;
- full misconduct/sanction progression, defaults, forfeits, expulsions, or
  disciplinary case handling;
- every form of score correction. Correction is intentionally absent from the
  rule-event schema, reducer, and authorization allowlists. It must wait for a
  separately designed privileged replay command that binds before/after state,
  rebuilds from the immutable event log, and revalidates all dependent state;
- media decoding/content inspection and calibration measurement; the technical
  ffprobe/hash preflight above is structural inventory only;
- ball, player, tracking, pose, audio, or event models;
- live ScoreCheck integration.

An authorized human point entry may continue while a side-switch or
technical-timeout obligation is pending; the obligation remains latched during
the active set. No automated event origin exists. If a terminal point closes
the set first, any obligation that was already overdue before that point is
preserved in the `SetResult` audit and emits
`SET_CLOSED_WITH_OPEN_OBLIGATIONS`; it is never silently erased.

Every rule event carries a `ruleset_fingerprint`: the lowercase SHA-256 of the
effective ruleset's canonical, UTF-8 JSON (sorted keys, compact separators, all
scoring/obligation parameters and `reducer_semantics_version` included). This is
distinct from the rule event's own content fingerprint. The reducer
computes/stores its ruleset value and rejects an exact mismatch. A hash binds an
event to ruleset bytes but is not a signature or authorization proof. Durable
replay must reparse and reverify every canonical authorized-event envelope,
reapply the complete ordered stream, compare every persisted derived-state
snapshot byte-for-byte, and additionally pin the reducer
artifact/container/commit digest. A state snapshot is only a cache. Rollback of
the entire log and policy archive remains an outer deployment-boundary threat
and requires a separately protected monotonic checkpoint.
