# Ball Label Pack V1

`ball_label_pack.py` is the immutable storage boundary for one complete
`CausalBallLabelBundleV1` and its concrete Annotation Truth V2 contracts. It
solves a narrow problem: a later trusted coordinator can reacquire one exact
generation and reconstruct the same label statement from the exact persisted
bytes that the statement names.

Loading a pack is not label-trust verification and never grants training,
evaluation, test, deployment, or live-scoring admission.

## Root and exact generation

The content-addressed root has exactly four fields:

```json
{
  "curator_attestation_ref": "sha256:<64 lowercase hex>",
  "curator_trust_snapshot_ref": "sha256:<64 lowercase hex>",
  "label_bundle_statement_ref": "sha256:<64 lowercase hex>",
  "schema_version": "1.0"
}
```

The three references must be canonical and distinct. `pack_sha256` is the raw
SHA-256 of these exact canonical root bytes. The protected caller supplies only
`label_store_root`, `generation_id`, and `pack_sha256`; there is no public load
path accepting preconstructed Python contracts.

One immutable generation contains exactly:

- the root;
- the referenced causal-ball label statement;
- the referenced curator attestation;
- the referenced curator trust snapshot;
- every annotation preimage referenced by the statement; and
- every detached annotation attestation referenced by the statement.

It contains no other object. The loader holds one shared generation lease from
root staging through reconstruction. Before parsing child contracts it derives
the complete transitive closure from the statement, requires every reference to
be globally unique across object types, and compares the closure byte-for-byte
with the generation descriptor's sorted digest tuple. Missing and extra objects
fail closed.

The evidence result returns annotation attestations in canonical statement
traversal order: frame order, annotation-reference order, then each reference's
canonical attestation-ref order. It does not preserve a publisher's unrelated
in-memory tuple order.

## Bounded parsing order

Production limits are fixed in code and cannot be relaxed by pack data:

| Boundary | Limit |
| --- | ---: |
| Generation objects | 20,000 |
| Aggregate loaded contract bytes | 256 MiB |
| Root | 4 KiB |
| Label statement | 1,900,000 bytes |
| Curator attestation | 4 KiB |
| Curator snapshot | 512 KiB |
| Ball annotation preimage | 64 KiB |
| Annotation attestation | 4 KiB |

Descriptor cardinality and root membership are checked before root parsing.
Each object is staged and digest-verified under its type-specific bound. The
complete contract byte set is aggregate-bounded before curator or annotation
child parsing. The statement must be parsed earlier because it is the only
authority for the transitive child-reference closure; its own fixed byte and
wire limits bound that work.

Immutable-store failures are translated to stable `BallLabelPackError` codes.
The original exception remains available as `__cause__`, while store-controlled
text is not reflected across the boundary.

## Rebinding and reconstruction

The loader does not trust a filename or reference alone. It:

1. requires each canonical wire parser to reproduce the exact input bytes;
2. recomputes and rebinds root, statement, curator, annotation, and detached
   attestation fingerprints to every content address;
3. requires the curator attestation to name the exact statement;
4. requires the snapshot's current entry to name the exact bundle, statement,
   and curator attestation;
5. requires the attestation's key, curator, role, and trust domain to match the
   snapshot's current authority entry;
6. requires every statement annotation reference to match the concrete
   annotation's ID, type, subject, role, visibility, and fingerprint;
7. requires every detached annotation attestation to bind that exact annotation
   type and fingerprint;
8. recomputes the complete annotation-attestation-set fingerprint; and
9. rebuilds `CausalBallLabelBundleV1` from the concrete annotations and detached
   attestations and requires byte-for-byte equality with the stored statement.

These checks establish content and relationship integrity only. The pack loader
does not verify curator signatures, reviewer/adjudicator signatures, key dates,
revocations, protected pins, evidence bytes, or policy eligibility. Those
checks require protected runtime inputs and remain the responsibility of the
existing label-bundle and Annotation Truth verifiers at a later admission
boundary.

## Deliberate exclusions and domain separation

Raw media, decoded pixels, review evidence, adjudication evidence, capture
integrity evidence, capture gaps, protected annotation trust stores, and
protected verification policies are not pack objects. The label contracts bind
many of those artifacts by digest, but the bytes live in their own protected
stores and leases.

Exact descriptor membership rejects simply adding any excluded object. A
second check prevents a deliberate cross-domain digest reuse from disguising
excluded state as an allowed contract. The allowed contract closure must be
disjoint from:

- source asset, finalized trace, capture policy, ontology, and decode-contract
  commitments;
- decoded-frame, frame-identity, and decoder-artifact commitments;
- the derived annotation-attestation-set commitment;
- annotation trust-store and verification-policy commitments; and
- every review, adjudication, frame-capture, and search-region evidence digest
  exposed by the concrete annotations.

Complete causal-ball bundles already reject unavailable decoded frames, so gap
and capture-segment evidence cannot enter a valid statement. They remain
outside the pack by the same rule.

## Evidence only

The successful result is a private, slotted, immutable implementation exposed
only through a private read-only protocol. Its contracts are frozen and its
object and annotation collections are tuples. Every admission property is
hard-coded `False`, including the explicit test-admission property.

This is true for `TRAIN`, `DEV`, and `TEST` statements. A `TEST` pack cannot be
mounted by a training worker merely because its storage closure loaded
successfully. A future coordinator must separately reacquire and verify the
current curator and annotation authorities, rights/derivation evidence, media,
split policy, and target-materialization contract before issuing any narrower
job admission.
