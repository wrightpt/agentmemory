# Action-read reliability deployment and rollback

Status: prepared only. Do not run this plan without fresh user approval for the
exact source commit, package digest, lock change, maintenance window, and
service restart.

## Authority and preflight

1. Deploy only an approved commit from the owned fork containing the
   action-read repair. Re-fetch it, require a clean checkout, and record the
   exact 40-character commit; a branch name is not a deployment pin.
2. Re-run the focused action tests, the full suite with isolated `HOME` and
   `TMPDIR`, `npm run build`, and the pristine-revision typecheck comparison.
3. Record a pre-deploy baseline from natural traffic: `/health`, the worker and
   iii PIDs/start times, iii `/proc/<pid>/smaps_rollup`, action-list trace
   latency, and engine invocation/error counters. Do not send synthetic load.
4. Preserve the current rollback inputs before changing anything:
   `fac2e916405c0a713e5b9a4e47b9658f7edf16df`, package digest
   `29e5f6314a7853c3e05a0b4162b38c1e367091cc704d0ae350c0f532392f9bfc`,
   `/home/cp/.local/share/agentmemory/packages/fac2e916405c0a713e5b9a4e47b9658f7edf16df-0.9.27.tgz`,
   the current deployment marker, lock, and live user unit.

## Build and pin

1. From the exact approved source commit, run `npm pack` into a new staging
   directory. Its `prepack` hook rebuilds `dist`; do not deploy an old build
   directory or use `npm link`.
2. Hash the emitted tarball. Update
   `agent-workspace-config/agentmemory-lock.json` with the owned-fork ref, exact
   source commit, version `0.9.27`, package SHA-256, and the intended build ID.
3. Update the tracked `agentmemory.service` documentation URL and
   `AGENTMEMORY_SOURCE_REVISION` to the same commit. Review and land that pin
   separately so Git, the lock, and the future live unit agree.
4. Before installation, run:

       python3 /home/cp/repos/agent-infra/agent-workspace-config/scripts/agentmemory_deployment.py --package <candidate.tgz> --lock /home/cp/repos/agent-infra/agent-workspace-config/agentmemory-lock.json

   This must verify the owned source, name/version, digest, and root-to-`dist`
   runtime configuration mirrors.

## Activation order

1. Announce the shared-memory-bus maintenance window and obtain final approval.
   Do not run migrations, heal, GC, or unrelated canaries.
2. Stop only `agentmemory.service`; its `ExecStop` performs worker-first graceful
   shutdown. Confirm both the Node worker and iii process exited. Leave
   `agentmemory-qdrant-shadow.service` running and abort if its prerequisite is
   unhealthy rather than broad-restarting services.
3. While stopped, take a timestamped byte-for-byte backup of the resolved live
   `/home/cp/data/state_store.db`, `/home/cp/data/queue_store`, and
   `/home/cp/data/stream_store` paths. Record checksums and free space.
4. Install the verified tarball with the current package prefix
   `/home/cp/.local`, install the approved tracked user unit, and run a user
   daemon reload.
5. Start only `agentmemory.service`. Require new worker/iii PIDs, HTTP 200 from
   `/livez`, and `/health` values matching the lock for `sourceRevision`,
   `version`, and `buildId`.
6. Record the deployment only after health matches:

       python3 /home/cp/repos/agent-infra/agent-workspace-config/scripts/agentmemory_deployment.py --package <candidate.tgz> --lock /home/cp/repos/agent-infra/agent-workspace-config/agentmemory-lock.json --record

7. Start `agentmemory-reconcile.service` so package-replacement plumbing and
   reranker warm-up converge, then run the health sentinel. This ordering lets
   the reconciler's sentinel see an already-valid deployment marker. The
   sentinel performs an actions write-path canary, so it belongs only inside
   the separately approved activation window.

## Soak and rollback gates

Sample at startup, 5, 15, 30, and 60 minutes, then 6 and 24 hours using natural
traffic:

- iii RSS/PSS, anonymous memory, private dirty memory, swap, threads, and the
  AgentMemory worker memory/CPU/event-loop fields from `/health`;
- recent `GET /agentmemory/actions` trace p50/p95/p99 and call volume, separated
  from health and unrelated endpoints;
- deltas in engine invocation success/error/deferred counters, HTTP 5xx,
  `state::list` timeout/unavailable errors, and same-revision retry recovery;
- revision continuity after natural action mutations, plus checkpoint, sentinel,
  lease, waiting, blocked, and actionable classification correctness.

Visible read errors may increase because the repair no longer converts failed
state reads into authoritative empty success. Classify those underlying errors
and require recovery on retry; do not treat error hiding as a healthier result.
The patch is not expected to make the existing multi-gigabyte iii residency
disappear. Roll back for new corruption, stale-revision results, failed retries,
health/lock mismatch, crash/OOM behavior, or a sustained regression against the
matched pre-deploy baseline—not merely because old retained RSS remains high.

For source rollback, stop only `agentmemory.service`, reinstall the preserved
`fac2e916` tarball under `/home/cp/.local`, restore its lock and user unit pin,
daemon-reload, start the service, verify health, record the old artifact again,
then reconcile and run the sentinel. Because this change has no migration, keep
the current live state during an ordinary source rollback. Restore the stopped
state backup only for separately diagnosed state corruption with explicit
approval, since doing so would discard writes made after deployment.

## Sentinel drift note

The sentinel always checks health, deployment-marker, and cached-package values
against the lock. When the global package is a symlink, it additionally compares
the symlinked repo `HEAD` with the locked revision and rejects source newer than
`dist`. The current installation is a packaged directory, so that conditional
repo-`HEAD` drift check is not active; the package digest, marker, and live
revision checks remain the applicable attestation.
