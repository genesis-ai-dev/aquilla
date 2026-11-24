# Offline-sync gate

The gate for the `offline-sync` risk area (`docs/RELEASE-RISK-GATES.md`,
forbidden outcome #4 "offline sync drops changes", and #1's "a commit that
never reaches the log"). Same shape as the auth matrix: a table, a committed
golden, an env var that regenerates it.

```bash
pnpm vitest run src/lib/sync/offline-gate/offline-gate.test.ts        # check
UPDATE_OFFLINE_GATE=1 pnpm vitest run src/lib/sync/offline-gate       # regenerate golden.json
```

| File | What it is |
| --- | --- |
| `scenarios.ts` | The table. One row is one scripted fault story. |
| `offline-gate.test.ts` | The interpreter, the invariants, the golden compare. |
| `harness.ts` | The faked edges: `fetch`, the socket, Web Locks, `indexedDB.open`. |
| `golden.json` | Per scenario: where each event ended up, and what the server saw. |

## What is real and what is faked

Real: `outbox.ts` over fake-indexeddb, the recovery journal
(`outbox-recovery.ts`), `flushOutboxBatch` and `drainCycle`, the sync-token
minter (`cqrs-bridge.ts` → `sync-token.ts`), `useOutboxFlusher` with its
Web-Lock loop, `outbox-sanitize.ts`, and `createWsReconciler`. Each "tab" is a
fresh module registry (`vi.resetModules`), so two tabs, or a page and its
reload, share IndexedDB, localStorage and Web Locks and nothing else.

Faked: the server (`GateServer`: `POST /events`, `POST /sync-token`, the
project socket; idempotent on event id, head compare-and-swap for
chain-mutating kinds), `navigator.locks`, `navigator.onLine`, and
`indexedDB.open` when a scenario freezes a page before its write lands.

Time never passes on its own. Timers are fake and move only on an `advance`
step; after every step the harness waits for the system to go quiet (no
request in flight, no IndexedDB task queued), which is a state and not a delay.
`Math.random` is pinned to 0.5, the identity draw for every jittered delay in
the area.

## The invariants

Computed by the harness for every row, from the server's log, a raw read of
the IndexedDB store and the journal keys in localStorage. A scenario cannot
state its own outcome.

1. Every enqueued event is in exactly one place: the server's log; the outbox
   (pending, or held as `failed` and still readable); the recovery journal; or
   removed after the server answered it with a permanent rejection (a 4xx
   other than 401/403). In none of them is **LOST** and fails the gate unless
   the row lists it under `knownLoss`. In two of them fails the gate.
2. Per cell, the server took events in the order they were enqueued.
3. An accepted event has the content that was enqueued. The one allowed
   difference is the documented repair in `outbox-sanitize.ts` (a fractional
   `…Ms` number rounded), and the golden row spells it out.
4. An event still in the outbox has the content that was enqueued and the
   account that enqueued it.
5. A live tab finished everything it started, and none of it threw.

The golden then pins the bucket of every event and, per scenario, the accepted
ids in server order, the number of `/events` posts, how often each event was
delivered, and the number of token mints. A behaviour change that loses
nothing still shows up as a golden diff.

## Findings pinned in the golden

- **`http: cell event with no fileId on its envelope` — E1 is LOST.**
  `flushOutboxBatch` deletes a non-`comment.*` event that has no `fileId`
  without posting it and without telling a listener. Deliberate
  (`outbox-flush.test.ts` pins it as "programmer error"), but it is a removal
  with no server verdict, which is what forbidden outcome #4 describes.
- **`hook: page torn down before IndexedDB stored the write` — E2 is LOST.**
  A single event that is not a `target.cell.commit` is not journaled
  (`journalTargetCommit`), so a page that dies between the enqueue call and
  the IndexedDB commit loses it. The commit in the same row, and the
  commit + validate enqueued as one batch, are recovered.

Behaviour that loses nothing but reads differently from the comments beside
it, each visible in its row:

- A 401 for one event inside a 200 burns the retry budget; after five the
  event is `failed` with `lastError=401`, which no reconnect or re-auth revives.
- A 401 on the POST itself does not re-mint: the cached sync token is reused
  until its client-side expiry.
- A new `authEpoch` restarts the flusher loop behind the old loop's Web Lock,
  so re-auth drains on the next 5 s tick, not at once.
- A tab that does not hold the lock keeps a stale queue size, so its
  wake-on-enqueue can miss; the event goes on the next tick.

## The socket rows

`ws-reconciler.ts` describes a write path where the reconciler "ships events
over this WS when healthy and falls back to POST `/events` otherwise". The
worker handles the frame (`outbox.event` in `sync-worker/src/project-do.ts`),
but no module under `src/` sends it: the shipped client drains over HTTP only.
The `ws:` rows therefore run the real reconciler under a sender written in the
harness (`WsFirstSender`): an event leaves the outbox only on its own ack,
unacked events are offered again after the socket closes, and a refused
`send()` runs the real HTTP drain. What those rows gate is the reconciler's
half: `send()` tells the truth, a dropped socket reconnects and `onOpen` fires,
`event.applied` / `event.stale` arrive parsed.

## Not covered

- **Multi-account drain** (`drainFlushTargets`, `ownerScope`, account switch
  mid-flush, `claimLegacyOutboxEvents`). Drivable here; not in the table yet.
- **The no-Web-Locks interval fallback** of `useOutboxFlusher`.
- **Tauri offline routing** (`planOfflineRouting`, `heldIds`,
  `recoverIntoQueues`, `offlineQueueWaitingIds`) and `src/lib/offline/`: needs
  the LiveStore runtime.
- **Storage quota recovery** (`withStorageQuotaRecovery`) and the v1→v3
  IndexedDB upgrade: fake-indexeddb has no quota.
- **Real page teardown.** `pagehide`, bfcache and a browser killing a tab mid
  transaction are approximated by freezing `indexedDB.open`; a transaction
  aborted half way needs a browser (Playwright).
- **Real Web Locks** across real tabs, and the real `AbortSignal.timeout` on a
  hung request (the scenario throws the `TimeoutError` instead).
- **Platform-view tokens** (AQU-2003), `flushOutboxUntilSettled`, stale-source
  pins, `flush-applied.ts` / `live-apply.ts` / `confirmed-target-heads.ts`
  (read-side landing of acked rows; they cannot lose a queued event), the
  heartbeat and in-band token refresh of the reconciler.
- **The real sync-worker.** The server is a fake; the contract with the real
  `/events` route is the events gate's and the smoke suite's.

## Wiring still to do

Nothing outside this directory was touched. To make this a gate the planner
reads: add `offline-sync` to `AREA_GATES` in `scripts/release-risk.mjs`, run
this file as a named check in `risk-label.yml` for PRs touching the area, fail
that check when `golden.json` changed, and classify this directory as gate
machinery (`infra`) so a PR cannot edit the harness and pass itself.
