// Dedicated leader worker for the offline LiveStore adapter. Bundled via the
// `?worker` Vite suffix and handed to `makeSingleTabAdapter({ worker: ... })`
// in store.ts — LiveStore boots its leader thread (SQLite + sync processor)
// inside this worker rather than the main thread.
import { makeWorkerEffect } from "@livestore/adapter-web/worker"
import { Effect } from "@livestore/utils/effect"
import { installLeaderLogForwarder } from "./leader-log-bridge"
import { installRebuildProgressForwarder } from "./boot-progress"
import { installReplaySkip } from "./replay-skip"
import { holdLeaderLock, LeaderLockStolenError, leaderLockName } from "./leader-lock"
import { warnLeader } from "./leader-warnings"
import { waitForOpfsFilesFree } from "./opfs-handles"
import { makeLocalSyncBackend } from "./local-sync-backend"
import { schema } from "./schema"
import { STORE_ID } from "./store-id"

if (import.meta.env.DEV) installLeaderLogForwarder()
installRebuildProgressForwarder()
installReplaySkip()

// What makeWorker() does, run under the leader lock (see leader-lock.ts), and
// only once no other leader has the OPFS files open (opfs-handles.ts). The
// lock is held until the runner exits, which is after the leader has closed
// its databases. Waiting before the runner starts loses no messages: the
// session sends nothing until the runner has said it's ready.
const lockName = leaderLockName(STORE_ID)
void holdLeaderLock(
  lockName,
  async (signal) => {
    await waitForOpfsFilesFree(STORE_ID, {
      onBusy: (file) => warnLeader("warn", `waiting for another leader to close ${file}`),
    })
    // A newer leader may have stolen the lock while this one waited on the
    // files; booting now would put two leaders on the same OPFS pool.
    signal.throwIfAborted()
    await Effect.runPromise(makeWorkerEffect({ schema, sync: { backend: makeLocalSyncBackend } }))
  },
  {
    onSlow: (ms) => warnLeader("warn", `still waiting for '${lockName}' after ${ms} ms — another leader holds it`),
    onSteal: (ms) => warnLeader("warn", `took '${lockName}' after waiting ${ms} ms — its holder never let go`),
  },
).catch((error: unknown) => {
  // A newer leader took the lock from this one (see STEAL_LOCK_MS in
  // leader-lock.ts): expected, not a crash. It still stops below, which
  // closes the files for the new leader. Any other AbortError is a real failure.
  if (error instanceof LeaderLockStolenError) {
    warnLeader("warn", `a newer leader took '${lockName}' — stopping this one`)
  } else {
    warnLeader("error", "leader worker stopped", error)
  }
  // Rethrown uncaught, so it fires `error` here first: the runner
  // (BrowserWorkerRunner) listens for that on `self` and closes, which closes
  // the databases and their OPFS handles without waiting on the page. It then
  // fires on the page's Worker object, the only failure the page can hear
  // before the leader says it's ready (a rejection here would go nowhere).
  // The adapter shuts the session down on it, but that doesn't fail the boot
  // in LiveStore 0.4.0, so store.ts (failBootOnLeaderError) rejects
  // getOfflineStore() with it, and OfflineLeaderWatchdog offers a restart.
  setTimeout(() => {
    throw error
  })
})
