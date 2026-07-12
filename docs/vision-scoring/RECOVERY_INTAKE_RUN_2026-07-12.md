# Recovery Intake Run — 2026-07-12

**Status:** deterministic quarantine inventory completed; no media bytes were
opened, hashed, decoded, copied, or admitted for training

## Inputs and outputs

| Item | Value |
|---|---|
| Historical probe CSV | `/Users/nathanhicks/Documents/Codex/2026-06-19/k/work/social_audit/all_non_scorecheck_video_probe.csv` |
| Input size | 8,886,069 bytes |
| Input SHA-256 | `da5c14e12698ef5c67ac335b2f3b1516e2bf58dbed5f0567d41477ef86c3bd46` |
| Input records | 32,957 |
| Accepted candidate locators | 32,955 |
| Rejected records | 2 |
| Sealed manifest | `/Users/nathanhicks/.codex/recovery-manifests/non-scorecheck-video-quarantine-expanded-da5c14e1.json` |
| Manifest file size | 46,562,047 bytes |
| Manifest file SHA-256 | `f740c7bba66b009e2fe05701efe0564a7ee240d0609bfb6f4318504d54ab8894` |
| Internal payload SHA-256 | `d712ef21e6563710784451465a9146b0f7b2cffd603d06a7882c5abec7f430db` |
| Output mode | owner-only `0600` |

The file SHA-256 covers the emitted JSON including its self-digest and trailing
newline. The internal payload SHA-256 is the manifest's canonical self-digest
with the `manifest_sha256` field omitted.

## Root policy used

The run pinned the exact current device/inode identity of the referenced local
Desktop, Downloads, Music, Movies, Documents, Developer, `worldmonitor`, and
`.hermes` directories. It separately required both `/Volumes/Nathan Footage`
and `/Volumes/T9` to be absent. Both volume paths were absent during the run.

The root pins establish equality to the operator-supplied runtime identities;
they do not establish volume ownership, persistent UUID, media rights, or
content identity.

## Result

| Availability | Candidates |
|---|---:|
| Resident regular-file metadata | 347 |
| Referenced on absent `/Volumes/Nathan Footage` | 29,024 |
| Referenced on absent `/Volumes/T9` | 3,472 |
| Offline/cloud placeholders beneath present roots | 112 |
| Out of scope | 0 |
| Unsupported or observation failure | 0 |

All 347 resident regular files are only eligible for a later byte-level
preflight. They are not rights-cleared, semantically verified volleyball media,
or training-ready. Metadata ranking produced:

| Metadata-only band | Resident candidates |
|---|---:|
| Medium | 2 |
| Low | 339 |
| Hold | 6 |

The two medium records are two paths for a venue-drone asset with the same
reported size; intake did not read bytes and therefore did not prove duplicate
content. The six hold records are zero-byte or historically failed probe
entries. This run did not identify a resident full-match corpus suitable for
model training.

One low-band resident filename is a plausible volleyball-service lead: a
23.483-second, historically reported 1080x1920 HEVC short-form clip also has a
same-size/duration locator on the absent Nathan Footage volume. This is still
only unverified filename and prior-probe metadata. It is too short/edited to be
a training corpus, but it may become a bounded pipeline smoke input after
Nathan gives separate, explicit approval to open it for byte-level preflight.
That approval would authorize only the preflight read; it would not establish
ownership, a participant release, signed rights, provenance, capture
observability, label truth, or admission for training/evaluation. Those
decisions require their own evidence and protected gates. No bytes from either
locator were read during this review.

The reported 1080p metadata does not establish a current feed. At most, this or
other recovered footage could later instantiate the historical Tier A profile
after bytes are recovered, accepted rights/releases are signed, and the exact
camera/content passes observability preflight.

## Safety interpretation

The manifest carries the sealed-observer claims:

- in-scope media bytes were not opened or hashed;
- absent roots were verified absent;
- directory-component symlinks were not followed;
- observation was wall-clock bounded;
- present root device/inode pins matched.

It remains a quarantine planning artifact. It does **not** establish media
content, duplicate identity, capture quality, rights, releases, provenance,
annotation validity, or permission to train or deploy.

## Next data action

Empirical camera/model work still requires one of these external changes:

1. mount `/Volumes/Nathan Footage` and/or `/Volumes/T9`, then repin the intended
   volume root through a trusted operator;
2. acquire immutable original files or owner-authenticated exports for the
   owner-declared Colorado Cupcakes or Beach Volleyball Videos catalog, then
   publish exact-asset signed rights decisions and participant/release evidence;
   or
3. capture a controlled pilot on the actual 1080p30 HEVC/SRT and 1080p60
   H.264/RTMP production profiles before the 720p30 program normalization.

Byte inspection is a separate authority from every item above. Nathan's
2026-07-12 owner declaration authorizes candidate discovery and bounded
byte-preflight for the two named channels; it does not substitute for an exact
signed rights decision, participant/venue release, provenance decision, or
downstream admission. Other resident footage still requires explicit scoped
approval. Select at most 256 authorized candidates per batch for the existing
byte-level media preflight. Do not bulk-preflight the 32,955 leads or infer
permission from filenames, paths, historical probe success, or this manifest.
