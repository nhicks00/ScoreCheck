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
2. identify which footage is owned or otherwise commercially trainable and
   publish signed rights decisions and release evidence; or
3. capture a new controlled native 4K60 rights-cleared pilot.

After that, select at most 256 explicitly approved candidates per batch for the
existing byte-level media preflight. Do not bulk-preflight the 32,955 leads or
infer permission from filenames, paths, historical probe success, or this
manifest.
