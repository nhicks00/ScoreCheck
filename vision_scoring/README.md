# Vision Scoring Foundation

This package is the hard-cutover foundation for assistive beach-volleyball
scoring. It intentionally contains no detector, tracker, or model runtime yet.

Architecture and readiness decisions live in
[the vision-scoring documentation](../docs/vision-scoring/ARCHITECTURE.md).

The domain transition boundary is explicit:

1. perception creates immutable observations and event proposals;
2. fusion creates a `RallyDecision` that may abstain;
3. a future authenticated authorizer will create and sign a `RuleEvent`;
4. `RulesReducer.reduce()` validates domain semantics and derives the next legal
   score state.

The reducer is **not** an access-control or security boundary. It does not
authenticate an actor, verify that an authority label was assigned by a trusted
service, verify a signature, or transactionally persist an event. The required
`authorization_id` is provenance linkage only; any in-process caller can
currently supply it. Do not expose the reducer directly to untrusted input or
use its acceptance of an event as proof that the event was authorized.

Run the unit tests without installing the package:

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

Validate a capture/data readiness manifest:

```bash
PYTHONPATH=src python3 -m vision_scoring.readiness examples/readiness-manifest.json
```

The readiness thresholds are engineering gates, not governing-body standards.

Implemented now:

- immutable frame, calibration, observation, proposal, decision, and rule-event contracts;
- deterministic set/match scoring with service-order validation;
- explicit replay/no-point plus latched side-switch and technical-timeout obligations;
- basic non-automatic authorized point aliases named `PENALTY_POINT` and
  `SERVICE_ORDER_FAULT`; these do not implement a sanctions, defaults, or
  discipline domain, and they require a unique scoring-opportunity ID in
  `related_rally_id` plus immutable evidence;
- a v0 compensating correction limited to the latest score/replay/correction
  event in the current/latest set;
- idempotent event replay and simultaneous reducer effects;
- capture, commercial-rights, checksum, and domain-split readiness validation.

Not implemented yet:

- persistence/transactional append storage;
- authenticated actor/role resolution, the evidence-to-`RuleEvent` authorization
  service, event signing, and signature verification;
- full misconduct/sanction progression, defaults, forfeits, expulsions, or
  disciplinary case handling;
- historical correction after a later event or set; that requires a replay
  service that rebuilds and revalidates all dependent state;
- correction of an already-seeded player roster or service-order tuple; v0
  requires rejecting the set seed and restarting before subsequent events;
- camera/media inspection and calibration measurement;
- ball, player, tracking, pose, audio, or event models;
- live ScoreCheck integration.

An authenticated human/referee point entry may continue while a side-switch or
technical-timeout obligation is pending; the obligation remains latched during
the active set. `AUTO_POLICY` point events are blocked while either obligation
remains. If an authoritative terminal point closes the set first, any obligation
that was already overdue before that terminal point is preserved in the
`SetResult` audit and emits `SET_CLOSED_WITH_OPEN_OBLIGATIONS`; it is never
silently erased. In this package, however, `OPERATOR`, `SCOREKEEPER`, and
`REFEREE_FEED` (as well as `IMPORT`) are caller-supplied enum values—not
authenticated identities.

Every rule event carries a `ruleset_fingerprint`: the lowercase SHA-256 of the
effective ruleset's canonical, UTF-8 JSON (sorted keys, compact separators, all
scoring/obligation parameters and `reducer_semantics_version` included). This is
distinct from the rule event's own content fingerprint. The reducer
computes/stores its ruleset value and rejects an exact mismatch. A hash binds an
event to ruleset bytes but is not a signature or authorization proof. Durable
replay must additionally pin the reducer artifact/container/commit digest.
