# Decoder loader V1 development harness

The development harness proves that the committed deterministic loader can
consume one exact checked decoder runtime and one exact synthetic DEV clip
through real immutable label, artifact, and runtime stores. It is plumbing
evidence only. Every receipt and declaration keeps training, evaluation, test,
deployment, live-scoring, production, legal, patent, security, support, and
general runtime-execution authority false.

## Run

First reproduce the decoder build described in
`DECODER_RUNTIME_DEVELOPMENT_BUILD.md`. Then, from `vision_scoring/`, use the
training environment because clip tensor encoding requires PyTorch:

```bash
PYTHONPATH=src python scripts/run_decoder_loader_development_v1.py
```

The command has no caller-selectable media, decoder, store, manifest, label,
or expected-receipt coordinates. It revalidates the final build receipt,
safe-opens and hashes both clean cache builds, remeasures the pinned macOS
system runtime, constructs a private three-store enclave, invokes
`load_causal_ball_clip_input_v1`, validates the tensor binding, compares the
clip receipt byte-for-byte with the checked fixture, and removes the enclave.

The expected successful summary commits these central results:

- build receipt: `5d30df230ba63141416d0cd867deaae19dd620f577709f3314effd189429db55`;
- runtime manifest: `6552aae9c33537c574be4c350256722d30a7941ba1855fc6501e6e265b84382e`;
- runtime generation: `8494f6ffa8cf7e6b0cc3f6395e1761cd6e8bb8dbd6feedbf29fcb41381806048`;
- HEVC10 media: `380fc82506dc596f572e5535c99713ee676f7c37e5682506e994d93df1cd3aa0`;
- label pack: `39e31b652d325a0c8d15549bb2f915414fcf02206201fee595816f527398ad55`;
- label generation: `a442867746e17bad4e0da49095e7b164e20430c650f3167b9722883447dc2381`;
- clip receipt: `e5cde1dfc7469ba1217372448319bc22803c55e72f9a9902965e17f2acadc151`;
- tensor: `2f5bc141998f6f481b01bce98ed669c868270a9560663958e8eb40977dc4c5dd`;
- tensor shape: `[1, 5, 3, 64, 64]`.

## Exact fixture chain

`decoder_runtime_v1.development-manifest.json` is derived from, rather than
independently chosen beside, the canonical development build receipt. It binds
the two cache-only executable hashes, normalized version outputs, exact
configure and build flags, recipe, empty non-system dependency closure,
`libSystem`-only ambient linkage, and the measured system-runtime generation.
Its `license_review_ref` addresses the development receipt whose legal and
patent reviews remain incomplete.

The loader uses the HEVC10 golden instead of the H.264 golden because the H.264
fixture's 12-pixel height is deliberately below the loader's minimum dimension.
The HEVC10 fixture is 64 by 64, uses global stream zero and time base 1/1000,
and has five distinct presentation frames at source PTS 103, 149, 211, 307,
and 467.

`decoder_loader_hevc10_v1.development-declarations.json` explicitly limits its
scope to the repository-generated synthetic fixture. The deterministic public
fixture keys are derived from labels committed in the harness source, so they
are not secrets and must never appear in protected production configuration.
They produce real Ed25519 fixture signatures under IDs beginning with
`untrusted-development-fixture-`.

The generated label bundle is DEV, never TRAIN or TEST. Because the generated
decoder pattern has no beach-volleyball semantics or match ball, each complete
frame carries a reviewed `NOT_PRESENT` match-ball observation over the full
64-by-64 frame. Frame identities bind the runtime manifest, absolute source
PTS, exact RGB24 hashes, source dimensions, and duplicate kind `NONE`.

`decoder_loader_hevc10_v1.development-clip-receipt.json` is the exact public
loader output. It contains no path or mutable capability, binds the model input
tensor, and leaves all admission fields false.

## Storage boundary

FFmpeg, FFprobe, source archives, build trees, logs, immutable store contents,
and tensor bytes remain under the local development cache and are never
repository artifacts. The repository contains only source, small canonical
JSON evidence, generated synthetic compressed media, tests, and documentation.

The harness creates all three store roots below one mode-0700 temporary enclave
before passing any root to the loader. Each root has a distinct canonical path
and inode. Generations use real content-addressed descriptors, lock files,
exclusive writer locks, and verified reader leases. The enclave is not a
general persistent publisher API and is never exposed to another reader while
being constructed.

Both the decoder-build cache and harness cache must resolve outside the current
repository/worktree and must be separate, non-nested namespaces. This check
happens before any cache directory or store is created, so changing `HOME` to a
path inside the checkout fails closed instead of placing cache-only artifacts
under Git's scope.

The checked builder and shared decoder-command Python sources are an explicit
repository-code development trust boundary, not sandboxed input. The harness
safe-opens and hashes both exact source preimages before importing the builder,
and the builder receipt binds those hashes again. This prevents accidental
source drift; it does not convert locally executable repository code into a
production authentication or hostile-code isolation mechanism.

## Deliberate limits

- The build receipt's `runtime_execution_approved` value remains false. An
  explicit local development test does not turn evidence into general runtime
  authority.
- The loader remeasures FFmpeg and FFprobe version output, while the harness
  separately remeasures the ambient macOS system runtime before calling it.
- Loading a ball-label pack structurally rebinds its exact contracts; it does
  not replace fresh protected annotation-trust, evidence, currentness, rights,
  readiness, leakage, or TEST-exclusion verification.
- No output of this harness is accepted by the future single-use training
  admission coordinator merely because the integration succeeds.
- Developer ID signing, notarization, LGPL compliance review, codec-patent
  review, security approval, support approval, and production distribution are
  still outside this development slice.
