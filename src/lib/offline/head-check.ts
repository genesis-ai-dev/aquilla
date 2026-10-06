// Catches a client session that booted from a state db the leader has
// since thrown away.
//
// The leader writes the state db and the eventlog as two separate files, so
// a crash or reload between the writes leaves them out of step (either one
// can end up ahead). Our @livestore/common patch makes the leader rebuild
// state from the eventlog when that happens — but the client session's
// fast-path boot has already read the stale state db straight from OPFS, and
// takes its idea of the leader's head from it. Its pushes then hang silently,
// in both directions (verified against saved stores: state ahead e0.2309 vs
// e0.2299, and eventlog ahead e0.327 vs e0.8591r3). One reload boots it from
// the rebuilt file.
//
// At boot the snapshot *is* the leader's state file, and nothing has been
// committed yet (the store isn't handed out until this passes), so with one
// window and no LiveStore sync backend the two heads must be identical.
//
// Reloads at most once per session: if the heads still disagree after that
// (e.g. the patch didn't apply), looping would only hide the problem — the
// leader watchdog surfaces the stalled writes instead.

/** The bits of a LiveStore event sequence number this check needs. */
interface SeqNum {
  global: number
  client: number
  rebaseGeneration: number
}

interface SyncStatesStore {
  _dev: {
    syncStates: () => Promise<{ session: { upstreamHead: SeqNum; localHead: SeqNum }; leader: { localHead: SeqNum } }>
  }
}

const RELOAD_MARKER = "offline:head-mismatch-reload"
// The leader only answers once it has booted, which includes rebuilding the
// state db from the eventlog — seconds for thousands of events.
const DEFAULT_TIMEOUT_MS = 30_000

const compare = (a: SeqNum, b: SeqNum): number =>
  a.global - b.global || a.client - b.client || a.rebaseGeneration - b.rebaseGeneration

const format = (s: SeqNum) => `e${s.global}.${s.client}${s.rebaseGeneration > 0 ? `r${s.rebaseGeneration}` : ""}`

export type HeadCheckResult = "ok" | "reloading" | "mismatch-after-reload" | "timeout"

export interface HeadCheckOptions {
  reload?: () => void
  storage?: Storage
  timeoutMs?: number
}

/**
 * Compares the head the client session believes the leader is at with the
 * leader's real head, and reloads once if they disagree.
 *
 * Resolves with "timeout" if the leader hasn't answered within `timeoutMs`
 * — a dead leader never does, and the caller must still get its store so the
 * leader watchdog can surface that — but keeps waiting in the background and
 * still reloads if a late answer shows a mismatch.
 */
export async function checkClientSessionHead(
  store: SyncStatesStore,
  { reload = () => window.location.reload(), storage = sessionStorage, timeoutMs = DEFAULT_TIMEOUT_MS }: HeadCheckOptions = {},
): Promise<HeadCheckResult> {
  const verdict = store._dev.syncStates().then((states) => judge(states, reload, storage))
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
  })
  return Promise.race([verdict, timeout]).finally(() => clearTimeout(timer))
}

const judge = (
  states: Awaited<ReturnType<SyncStatesStore["_dev"]["syncStates"]>>,
  reload: () => void,
  storage: Storage,
): HeadCheckResult => {
  const sessionUpstream = states.session.upstreamHead
  const sessionLocal = states.session.localHead
  const leaderHead = states.leader.localHead
  // Normally the leader sits between what the session has had confirmed and
  // what it has committed (its pushes may be in flight). Before any commit
  // that means equal to the session's upstream head.
  if (compare(sessionUpstream, leaderHead) <= 0 && compare(leaderHead, sessionLocal) <= 0) {
    storage.removeItem(RELOAD_MARKER)
    return "ok"
  }

  const detail = `client session expects leader at ${format(sessionUpstream)}, leader is at ${format(leaderHead)}`
  if (storage.getItem(RELOAD_MARKER) !== null) {
    console.error(`[offline] Local store still inconsistent after a reload — ${detail}`)
    return "mismatch-after-reload"
  }
  console.warn(`[offline] Local store booted from a stale state db — ${detail}; reloading`)
  storage.setItem(RELOAD_MARKER, String(Date.now()))
  reload()
  return "reloading"
}
