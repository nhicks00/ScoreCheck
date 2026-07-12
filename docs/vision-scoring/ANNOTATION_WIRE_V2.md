# Annotation Wire V2

`BallFrameAnnotationV2` and `AnnotationAttestation` now have a strict persisted-byte
contract:

```python
raw = annotation.to_json_bytes()
restored = BallFrameAnnotationV2.from_json_bytes(raw)

attestation_raw = attestation.to_json_bytes()
restored_attestation = AnnotationAttestation.from_json_bytes(attestation_raw)
```

This is a serialization boundary only. Parsing an annotation or attestation does
not verify reviewer authority, evidence objects, current trust-store state, data
rights, split policy, training admission, evaluation admission, deployment, or
live scoring.

## Canonical byte rules

The wire representation is sorted, compact JSON encoded as exact UTF-8. It has no
insignificant whitespace, duplicate object keys, alternate string escapes, or
unsupported fields. Every object, including every nested geometry and frame
object, has the exact V2 field set and `schema_version` value. Enum values and
nested JSON types are exact.

Integers must fit signed 64-bit range. Annotation geometry may use finite JSON
floating-point values. Alternate numeric spellings are not aliases: examples
such as `1` in place of canonical `1.0`, `1.00`, `1e0`, and normalized `-0.0`
are rejected. `NaN`, positive or negative infinity, and an exponent that decodes
to a non-finite value are rejected.

The existing `parse_canonical_json_object` contract remains integer-only. Float
support is isolated in `parse_canonical_finite_json_object`; callers do not gain
float acceptance by using the original parser.

Unicode text is encoded directly as canonical UTF-8. The existing annotation
contract continues to require NFC normalization for human ambiguity text.
Escaped aliases and non-NFC spellings do not round-trip as the same persisted
contract.

## Fail-closed bounds

Bounds are applied after strict JSON parsing but before any annotation or
attestation dataclass is constructed.

| Contract | Bytes | Depth | Nodes | Containers |
| --- | ---: | ---: | ---: | ---: |
| Ball frame annotation V2 | 65,536 | 12 | 4,096 | 512 |
| Annotation attestation | 4,096 | 2 | 32 | 1 |

The parser also rejects duplicate keys and signed-64 integer overflow before
construction. These checks bound the wire tree; the existing domain constructors
then apply their tighter limits on reviewers, evidence references, dimensions,
text, geometry, and legal field combinations.

## Reconstruction check

Deserialization has two independent canonicality checks:

1. The parsed JSON tree must re-encode to the original bytes.
2. The fully reconstructed contract must re-encode to the original bytes.

The second check catches semantic normalization that a generic JSON parser cannot
see, including integer/float aliases, negative zero, and noncanonical ordering of
sets represented on the wire as arrays.

Set-like tuples reachable from `BallFrameAnnotationV2` are normalized into
sorted tuple order during object construction. Consequently, object-to-bytes-to-
object round trips preserve dataclass equality as well as bytes and fingerprints;
caller insertion order has no persisted semantic meaning.

Wire failures use `CanonicalWireError` with stable machine-readable codes. JSON
syntax and resource failures retain their specific codes, while invalid V2
annotation and attestation shapes use `ANNOTATION_SHAPE` and
`ATTESTATION_SHAPE`. A reconstruction mismatch uses
`NONCANONICAL_CONTRACT`.

## Fingerprint compatibility

The existing annotation and attestation fingerprint algorithms are unchanged.
For valid objects, `to_json_bytes()` is the same UTF-8 canonical JSON byte stream
already hashed by the corresponding fingerprint method. Regression fixtures pin
both fingerprints while exercising persisted-byte round trips.
