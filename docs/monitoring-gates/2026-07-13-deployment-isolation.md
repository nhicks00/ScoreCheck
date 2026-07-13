# Program-Browser Deployment Isolation

Date: 2026-07-13
Status: defect confirmed; guard prepared locally and awaiting a coordinated deployment after the active soak

## Finding

Commit `fcfaa694` changed only monitoring infrastructure and documentation, but
pushing it to the Git branches connected to Vercel still initiated a web
deployment. Courts 1, 3, and 5 reloaded their active program browsers together
between `2026-07-13T13:42:28Z` and `13:42:41Z`. All three returned healthy
within about one minute on build `fcfaa694ff0a9d6262115e2e3fe5d58d72579a26`.
Raw, preview, program media paths, Egress jobs, and YouTube remained available,
so the common event was the application rollout rather than a media-routing
failure.

The observability containers were also restarted near that time to rotate an
internal webhook credential. They do not control the program pages and are not
the likely reload source. The Git-triggered Vercel rollout is the shared cause
supported by the page build identifier.

## Correction

Two independent corrections are required.

First, the web project's `vercel.json` now uses this ignored-build command:

```text
git diff HEAD^ HEAD --quiet -- .
```

Vercel runs the command from the configured `apps/web` root. Exit code zero
skips a deployment when that directory did not change; a web change returns a
nonzero exit code and proceeds. The guard fails open to a build when Git cannot
evaluate the parent commit, which is safer than suppressing an uncertain web
release.

Second, the overlay embedded inside `/program/court/{court}` no longer performs
the standalone overlay's automatic build-version reload. A running program
browser stays pinned to the build it opened with until Egress or an operator
restarts it, or its existing video watchdog reaches a genuine fatal-recovery
reload. Standalone overlay browser sources retain their version refresh.

This is a hard cutover, not a feature flag. It separates application release
cadence from an active program output while preserving crash and media-stall
self-healing.

The corrections change `apps/web`, so their first coordinated production push
will perform one expected web deployment. Program browsers still running the
old build will execute their old version-reload behavior once. After that
cutover, monitoring-only, infrastructure-only, and documentation-only commits
must not deploy the web project, and later web deployments must not reload
already-running program browsers.

## Acceptance Gate

After the active soak and during a coordinated test window:

1. Deploy both corrections with no live match in progress and confirm the expected one-time reload from browsers still running the old build.
2. Push a no-op documentation-only test commit or use an equivalent isolated branch deployment trigger.
3. Confirm Vercel reports the build ignored and the production alias/build identifier does not change.
4. Confirm every active program browser keeps its heartbeat sequence, reload count, WebRTC counters, and frame continuity.
5. During a later coordinated web deployment, confirm already-running program browsers remain on their pinned build without reloading while standalone overlays still refresh.
6. Record the Vercel deployment results and browser evidence before accepting the corrections.

Until this gate passes, no repository push is considered harmless during live
coverage, even when its diff does not touch the web application.
