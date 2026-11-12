// Commits `v1.LocalCheckpoint` once the store goes quiet after writing, so the
// leader can confirm (and stop holding in memory) every client-only event
// before it — see local-sync-backend.ts for why that's needed at all.
//
// Polls the session's head rather than subscribing: `syncStatus()` is a cheap
// local read, and one checkpoint per burst of writes is plenty. The first
// tick always checkpoints, which clears whatever backlog an earlier build
// (with no backend) left unconfirmed in the eventlog.
import type { Store } from "@livestore/livestore"
import { events, type schema } from "./schema"

type CheckpointStore = Pick<Store<typeof schema>, "commit" | "syncStatus">

export interface LocalCheckpointOptions {
  /** How often to look for new writes; a checkpoint lands within ~2 ticks of the last one. */
  checkEveryMs?: number
}

const DEFAULT_CHECK_EVERY_MS = 5_000

const headOf = (store: CheckpointStore): string => String(store.syncStatus().localHead)

/** Starts checkpointing `store`; returns a function that stops it. */
export function startLocalCheckpoints(store: CheckpointStore, options: LocalCheckpointOptions = {}): () => void {
  const checkEveryMs = options.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS
  // The head right after our last checkpoint, and the head seen on the
  // previous tick: checkpoint only once the head has moved since the former
  // and then held still for a tick (a download commits in bursts; one
  // checkpoint at the end beats one per tick).
  let checkpointedAt: string | undefined
  let lastSeen: string | undefined

  const tick = () => {
    const head = headOf(store)
    const moved = head !== checkpointedAt
    const settled = head === lastSeen || checkpointedAt === undefined
    lastSeen = head
    if (!moved || !settled) return
    store.commit(events.localCheckpoint({}))
    checkpointedAt = headOf(store)
    lastSeen = checkpointedAt
  }

  tick()
  const timer = setInterval(tick, checkEveryMs)
  return () => clearInterval(timer)
}
