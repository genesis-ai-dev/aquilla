// Dedicated leader worker for the offline LiveStore adapter. Bundled via the
// `?worker` Vite suffix and handed to `makeSingleTabAdapter({ worker: ... })`
// in store.ts — LiveStore boots its leader thread (SQLite + sync processor)
// inside this worker rather than the main thread.
import { makeWorkerEffect } from "@livestore/adapter-web/worker"
import { Effect } from "@livestore/utils/effect"
import { installLeaderLogForwarder } from "./leader-log-bridge"
import { installRebuildProgressForwarder } from "./boot-progress"
import { installReplaySkip } from "./replay-skip"
import { holdLeaderLock, leaderLockName } from "./leader-lock"
import { makeLocalSyncBackend } from "./local-sync-backend"
import { schema } from "./schema"
import { STORE_ID } from "./store-id"

if (import.meta.env.DEV) installLeaderLogForwarder()
installRebuildProgressForwarder()
installReplaySkip()

// What makeWorker() does, run under the leader lock (see leader-lock.ts). The
// lock is held until the runner exits, which is after the leader has closed
// its databases. Waiting before the runner starts loses no messages: the
// session sends nothing until the runner has said it's ready.
void holdLeaderLock(leaderLockName(STORE_ID), () =>
  Effect.runPromise(makeWorkerEffect({ schema, sync: { backend: makeLocalSyncBackend } })),
).catch((error: unknown) => console.error("[offline] leader worker stopped", error))
