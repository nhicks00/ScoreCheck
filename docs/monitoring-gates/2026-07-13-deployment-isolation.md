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

The web project's `vercel.json` now uses this ignored-build command:

```text
git diff HEAD^ HEAD --quiet -- .
```

Vercel runs the command from the configured `apps/web` root. Exit code zero
skips a deployment when that directory did not change; a web change returns a
nonzero exit code and proceeds. The guard fails open to a build when Git cannot
evaluate the parent commit, which is safer than suppressing an uncertain web
release.

The guard itself changes `apps/web`, so its first coordinated production push
will perform one expected web deployment. After that cutover, monitoring-only,
infrastructure-only, and documentation-only commits must not change the
production program-page build or reload active browsers.

## Acceptance Gate

After the active soak and during a coordinated test window:

1. Deploy the guard with no live match in progress and confirm the expected one-time browser reload.
2. Push a no-op documentation-only test commit or use an equivalent isolated branch deployment trigger.
3. Confirm Vercel reports the build ignored and the production alias/build identifier does not change.
4. Confirm every active program browser keeps its heartbeat sequence, reload count, WebRTC counters, and frame continuity.
5. Record the Vercel deployment result and browser evidence before accepting the guard.

Until this gate passes, no repository push is considered harmless during live
coverage, even when its diff does not touch the web application.
