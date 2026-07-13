# Decoder runtime V1 development build

This slice produces reproducible development evidence for the narrow macOS
decoder candidate. It does **not** publish an immutable runtime generation and
does not grant training, evaluation, deployment, live-scoring, production,
support, security, patent, or license authority.

## Measured host assumption

The current recipe is deliberately host-generation-specific:

- arm64 macOS 26.5.1 (25F80), Darwin 25.5.0;
- deployment target 26.0;
- Xcode 26.6 (17F113), Apple clang 21.0.0, Apple ld 1267;
- macOS 26.5 SDK with pinned `SDKSettings.json` and `libSystem.B.tbd` hashes.

A different host, SDK, compiler, linker, GnuPG executable, signing key,
source archive, configure closure, capability list, Mach-O surface, or golden
result stops the script. This is not a compatibility promise for other macOS
generations.

## Reproduction command

From `vision_scoring/`:

```bash
.venv/bin/python scripts/build_decoder_runtime_v1.py
```

The script permits only the development cache
`~/.cache/codex/scorecheck-ffmpeg-runtime-v1`. Downloads, extracted source,
two clean build trees, binaries, and logs remain there and are not repository
artifacts. The repository receives only the builder, pure tests, this document,
and the canonical development receipt.

The build verifies the official FFmpeg 8.1.2 archive SHA-256
`464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
and its detached signature against full release-key fingerprint
`FCF986EA15E6E293A5644F10B4322F04D67658D8` in a clean GnuPG home.
GnuPG runs with `--no-options --no-autostart`, so verification neither reads
ambient option files nor leaves an agent or smart-card daemon behind. External
audit and supply-chain tools receive a fixed C/UTC environment with no
`DYLD_*` or proxy variables; the pinned download path disables environment
proxy discovery.

## Narrow component and linkage policy

The recipe uses `--disable-autodetect --disable-everything`, static FFmpeg
libraries, no network, no hardware acceleration, and no external codec
libraries. Its intentional public component closure is:

- H.264 and HEVC decoders;
- MOV/MP4-family demuxer;
- rawvideo encoder solely for deterministic RGB24 output;
- rawvideo and framehash muxers;
- fd and pipe protocols;
- only the filters required by the fixed RGB24 conversion graph and FFmpeg's
  unavoidable graph plumbing.

FFmpeg 8.1.2 probes CoreFoundation, CoreVideo, and CoreMedia unconditionally
through its Objective-C compiler even when autodetection, VideoToolbox, and
the relevant platform features are disabled. The selected components contain
no Objective-C code, so the recipe pins `--objcc=/usr/bin/false`. This prevents
those implicit framework links without patching signed source. Both resulting
executables have an empty non-system dependency closure and exactly one direct
dynamic dependency: `/usr/lib/libSystem.B.dylib`. macOS still uses
`/usr/lib/dyld`; this is a static-FFmpeg/system-runtime binary, not a literally
static Mach-O executable.

## Acceptance performed on 2026-07-12

Two clean serial builds produced byte-identical executables:

- `ffmpeg`: `780aa8f1fe15a86c97d16181fb8867f13424adc95106f2b5dbf8eee0cac54a1e`;
- `ffprobe`: `edbb6ea959a7df036e8d1d7122c21b172f439e63633c19b9908246b2e69d3013`.

The receipt records each object hash independently for build A and build B.
It also binds the exact audit implementation and shared command contract:

- builder source: `16002a0bb56eb4d6987716330ce043638b2d179e391e22d808abe200b4b15c5d`;
- `src/vision_scoring/decoder_commands.py` schema 1.0:
  `d5d9d7af27983f0d2e2ea3d49ab1dd798512762358038b4e7c578902206c22d1`.

The command module is the same pure source consumed by the protected loader
and this independent build audit. The receipt validator rejects missing or
unknown fields, altered nested evidence, inconsistent derived hashes, a
different builder or command module, local-path leaks, or any true authority
field.

The audit verified thin arm64/ARM64-ALL Mach-O headers, deployment target and
SDK load commands, deterministic UUIDs, exact `libSystem`-only linkage, no
weak/upward/lazy/RPATH/dyld-environment commands, no dynamic-loading,
networking, or process-spawn imports, and valid linker-generated ad-hoc
signatures. The ad-hoc signature is development evidence; it is not a
Developer ID signature or distribution approval.

Candidate execution uses the loader-equivalent sanitized environment,
`DEVNULL` stdin, executable-parent working directory, closed descriptors, and
the exact shared fd-only probe/decode arguments. All external commands run in
new process groups; timeout, interruption, or a surviving descendant triggers
bounded TERM/KILL cleanup and reap. The strict framehash parser accepts only
its ten fixed headers and exact expected row count. Both pinned goldens passed:

- H.264/VFR/B-frame/rotation contract;
- HEVC `hvc1`, 10-bit, BT.709 limited-range, VFR/B-frame contract.

The canonical receipt is
[`decoder_runtime_v1.development-receipt.json`](../../vision_scoring/tests/fixtures/decoder_runtime_v1.development-receipt.json).
It contains no cache or worktree paths, measures the dyld-cache `libSystem`
re-export UUID closure, and keeps every authority field false. Its SHA-256 for
this run is
`5d30df230ba63141416d0cd867deaae19dd620f577709f3314effd189429db55`.

## Deliberately not completed here

- no immutable decoder-runtime generation was created;
- no runtime manifest or independent admission pin was approved;
- no Developer ID signing, notarization, or distribution work was performed;
- no legal, LGPL-compliance, codec-patent, security, or support approval was
  inferred from the configure report;
- no training, evaluation, deployment, or live-scoring admission was enabled.

Those are separate review and publication steps. The development receipt must
not be converted into authority merely because every technical check recorded
here passed.
