The private closeout guard holds AgentMemory's existing action-store lock and maintenance write barrier while an authenticated workstation broker performs one native effect. It does not approve closing a session. The broker must independently enforce its standing grant, launch provenance, protection, input, work preservation, confirmation, deny list and one-use close authorization.

Both POST endpoints require a configured `AGENTMEMORY_SECRET` and its Bearer credential. An unset secret returns 503; a wrong or absent credential returns 401. A declared agent header does not authenticate the caller. There are no MCP tools, arbitrary command arguments or caller-selected filesystem paths.

`POST /agentmemory/maintenance/closeout-guard/acquire` accepts:

```json
{"protocol":"closeout-guard/v1","requestId":"unique-request","session":"shared-auto-launch-interactive-codex-example","projectIds":["example"]}
```

The broker supplies its complete configured imported-project list. Claims and leases are always scanned across all projects, including orphan leases. Session bindings include the exact session, `wsh:<session>`, the legacy `wsh:<first 128 characters>`, and active action `tmux:` tags with both full and truncated names. Any bound nonterminal action or active lease refuses the acquire. Failed, malformed, duplicate or excessive inventories also refuse; there is no empty-result fallback.

Action status, optional action lifecycle, and lease status must be primitive strings in their respective enums. Arrays, objects, null and other non-string values return `closeout_guard_invalid_inventory` before a capability or usable native guard is published, even when a value would stringify to `done`, `cancelled` or `active`. Omitted action lifecycle remains supported; only validated terminal strings can establish a completed historical action binding.

A successful response contains `success`, `protocol`, `guardId`, `requestId`, `session`, `capability`, `expiresAt`, `snapshot`, `evidenceDigest`, `lock`, and `liveFile`. The stable snapshot has this shape:

```text
{version:1, session, aliases, actionRevision,
 actions:{count,digest}, leases:{count,digest}, claims:[], activeLeases:[],
 workAuthority:[{projectId,phase,generation,authority}]}
```

Digests use canonical SHA-256. Inventory digests include sanitized identity, ownership, status and lease fields. Work-authority rows retain admission hashes, generation, scope, mapping and selection mode; an absent authority is explicit. The evidence digest excludes guard IDs, clock readings and the maintenance barrier revision, so unchanged evidence matches across separate acquisitions. No action titles, descriptions, transcripts, credentials or other free text enter the snapshot.

The native witness is `{file,pid,fd,dev,ino,startTicks,socket,nonce}`. The owner-only liveness JSON binds protocol, guard/request/session, evidence digest, expiry, engine `{pid,startTicks,bootId}` and lock `{file,pid,fd,dev,ino,startTicks}`. It contains neither capability nor socket nonce. The broker validates these fields and the current incarnations synchronously at its final native condition. The helper supplies the same open file description through Unix `SCM_RIGHTS` exactly once. Opening `/proc/<pid>/fd/<fd>` does not provide the same guarantee.

`POST /agentmemory/maintenance/closeout-guard/release` accepts:

```json
{"protocol":"closeout-guard/v1","guardId":"returned-guard","capability":"returned-capability"}
```

Release is idempotent. `{success:true,status:"released",released:true}` means the descriptor drain completed. A bounded response with `{success:false,status:"draining",released:false,error:"closeout_guard_draining"}` means the guard still holds writers; retry that release, never replay the native effect. A proven drain with an audit or other lifecycle failure has `released:true` and `success:false`. Identical acquire requests may retrieve the same active guard; a changed request ID scope or a completed request cannot mint another capability. Replay memory is bounded to 128 requests per worker.

Acquire waits at most five seconds to become usable; a queued request that expires cannot acquire later. A usable guard has a 30-second start deadline. Expiry or release removes liveness, stops handoffs and closes the helper's original descriptor. A fresh open description must then acquire the same inode exclusively. This waits for every inherited native descriptor to close. The helper never calls `LOCK_UN` on the shared description. The native bridge must retain its descriptor through the server's execution acknowledgement, and transport timeouts must not signal that bridge.

A deadline never releases writers while a native effect can still execute. Unknown drain outcomes remain pending inside the maintenance callback; throwing through its `finally` would release writers and is forbidden. HTTP/iii invocation completion does not own controller lifetime. A stuck native bridge can hold guarded writers indefinitely until completion or separately authorized reconciliation. Audit uses the existing `recordAudit` ledger with `closeout_guard` lifecycle phases and evidence digest, without capabilities or nonce values. Acquired audit must succeed before liveness becomes usable.

The stable `closeout-guard/effect.lock` and its identity record live below configured `dataDir`; transient sockets and liveness files use private subdirectories. Startup drains that same inode before registering any writers. Never unlink/recreate the stable inode as cleanup, or start an old package that lacks this startup rule while a guard may remain outstanding. Unsafe inode evidence refuses initialization. Native transport requires Linux, `/proc`, Unix sockets, flock and `/usr/bin/python3`.

The acquisition order is Beads native barriers and all WorkProvider/engine scope reads, then AgentMemory's action-store lock, recovered action events, maintenance barrier and fresh raw inventories. Do not call public action-list, work-authority-get, WorkProvider scope/mission methods or per-action lease locks inside the engine guard: those paths reenter locks and can deadlock. Validate the returned fresh authority rows against the broker's configured pins. The maintenance barrier also blocks unrelated guarded memory writes during a close.

This protocol assumes one authoritative AgentMemory worker and trusted private callers under the same OS user. It does not isolate a malicious same-UID process, direct engine-storage writes, hostile root, or destruction of every native bridge/client after command dispatch. Descriptor drain handles ordinary broker/runner loss and transport timeout; it is not a claim of process-group crash atomicity. The guard creates no task store, claims, leases or session-close authority.
