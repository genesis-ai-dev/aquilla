// A LiveStore sync backend that never leaves the device.
//
// The offline store has no LiveStore upstream — Aquilla's own outbox
// (`event_queue`, flushed by sync-adapter.ts) is what talks to the server.
// Without a backend, though, LiveStore's leader never sees an event
// confirmed, so every event it has ever persisted stays in its in-memory
// `pending` list, rebuilt from the eventlog on every boot. Measured
// 2026-10-15: one downloaded 31k-cell project = 253 events / 13.2 MB pending,
// and each leader `syncState` call serialised all of it (~9 s of worker CPU,
// stalling pushes behind it). Weeks offline only grows it.
//
// This backend confirms whatever the leader pushes, by echoing it back
// through the live pull stream (LiveStore confirms on pull, not on push).
// Only *global* events are ever pushed, and every Aquilla event is
// client-only, so local-checkpoint.ts commits a tiny global checkpoint after
// activity: confirming it confirms every client event before it, which
// empties `pending` and lets the leader trim its session-changeset rows.
// The events themselves stay in the eventlog on disk.
import { SyncBackend } from "@livestore/common"
import { Effect, Option, Queue, Stream, SubscriptionRef } from "@livestore/utils/effect"

export const makeLocalSyncBackend: SyncBackend.SyncBackendConstructor = () =>
  Effect.gen(function* () {
    const echo = yield* Queue.unbounded<SyncBackend.PullResItem["batch"][number]["eventEncoded"]>()
    const isConnected = yield* SubscriptionRef.make(true)

    return SyncBackend.of({
      isConnected,
      connect: Effect.void,
      ping: Effect.void,
      // Nothing lives "upstream", so a catch-up pull from any cursor is
      // empty; a live pull then carries the echoes of what we push.
      pull: (_cursor, options) =>
        options?.live === true
          ? Stream.concat(
              Stream.make(SyncBackend.pullResItemEmpty()),
              Stream.fromQueue(echo).pipe(
                Stream.chunks,
                Stream.map((chunk) => ({
                  batch: [...chunk].map((eventEncoded) => ({ eventEncoded, metadata: Option.none() })),
                  pageInfo: SyncBackend.pageInfoNoMore,
                })),
              ),
            )
          : Stream.make(SyncBackend.pullResItemEmpty()),
      push: (batch) => Queue.offerAll(echo, batch),
      metadata: { name: "aquilla-local", description: "Confirms locally; the outbox does the real sync" },
      supports: { pullPageInfoKnown: true, pullLive: true },
    })
  })
