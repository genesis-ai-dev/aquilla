// Layer-1 warming (smooth-playback round): quietly download a file's dub
// clips into the on-device byte cache while the Media lens is open, so
// playback, scrubbing and seeking never wait on the network. Clip ids are
// immutable (a new take always gets a new id), so a warmed clip stays valid
// forever — this cost is paid once per device, not once per session.
//
// Politeness rules:
//   - nearest-first from where the user is working (selection outward), so
//     the clips most likely to play are stocked first;
//   - two fetches in flight at a time, never more;
//   - already-cached clips are skipped via an index-only existence check that
//     deliberately does not bump LRU;
//   - the sweep STOPS when the cache budget is nearly full — warming must
//     never evict clips to make room for other clips (a naive sweep of an
//     over-budget project would evict its own beginning and end up protecting
//     exactly the wrong region);
//   - abort()able — leaving the lens abandons the sweep mid-flight;
//   - (2026-08-05) it always YIELDS to live playback — while the transport is
//     waiting on bytes every worker parks, and while it is playing at most
//     one fetch runs;
//   - (2026-08-05) it adapts to the CONNECTION — a metered (saveData) or 2g
//     link stops the sweep entirely, 3g runs one worker. See warm-policy.ts.

import { activeTargetForCell } from "./track-audio"
import { warmGate } from "./warm-policy"
import { fetchCellAudio, parseFrontierAudioUrl } from "./upload"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { audioCacheAvailable, audioCacheBudget, audioCacheHas, audioCachePut, audioCacheUsage } from "./bytes-cache"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

/** Stop stocking when the pantry is within this margin of its budget (a clip
 *  or two of slack so a fetch in flight can't meaningfully overshoot). Scaled
 *  down for small budgets so the margin can never swallow the whole budget. */
const BUDGET_HEADROOM_BYTES = 4 * 1024 * 1024
const budgetHeadroom = (budget: number): number =>
  Math.min(BUDGET_HEADROOM_BYTES, Math.floor(budget / 50))

/** How often a parked worker re-asks the gate. */
const YIELD_POLL_MS = 250
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface WarmFileDubsArgs {
  cells: readonly CellData[]
  projectId: string
  session: FrontierSession
  signal?: AbortSignal
  /** Sweep outward from this cell (the selection); absent → file order. */
  nearCellId?: string | null
  concurrency?: number
}

export interface WarmFileDubsResult {
  warmed: number
  alreadyCached: number
  failed: number
  /** Why the sweep ended. */
  stopped: "done" | "aborted" | "budget" | "cache-unavailable" | "metered" | "slow"
}

interface WarmTarget {
  cellId: string
  fileId: string
  audioId: string
  ext: string
}

/** The file's dub clips in nearest-first order around `nearCellId`. */
export function planWarmOrder(
  cells: readonly CellData[],
  nearCellId?: string | null,
): WarmTarget[] {
  const targets: (WarmTarget | null)[] = cells.map((cell) => {
    if ((cell.medium ?? "text") !== "media") return null
    const target = activeTargetForCell(cell)
    if (!target) return null
    const frontier = parseFrontierAudioUrl(target.url)
    // Direct/blob URLs need no warming (they're local or plain-fetchable).
    if (!frontier) return null
    return { cellId: cell.id, fileId: cell.fileId, audioId: frontier.audioId, ext: frontier.ext }
  })
  const present = targets
    .map((t, i) => (t ? { t, i } : null))
    .filter((x): x is { t: WarmTarget; i: number } => x != null)
  if (present.length === 0) return []

  const centerIdx = nearCellId ? cells.findIndex((c) => c.id === nearCellId) : -1
  if (centerIdx < 0) return present.map((x) => x.t)
  // Interleave outward: the verse you're on, then its neighbours, widening.
  return present
    .map((x) => ({ t: x.t, d: Math.abs(x.i - centerIdx) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.t)
}

export async function warmFileDubs(args: WarmFileDubsArgs): Promise<WarmFileDubsResult> {
  const { cells, projectId, session, signal, nearCellId } = args
  const concurrency = Math.max(1, args.concurrency ?? 2)
  const result: WarmFileDubsResult = { warmed: 0, alreadyCached: 0, failed: 0, stopped: "done" }
  if (!session?.jwt) return result

  // FORTIFY: with no persistent cache (private browsing / restricted OPFS)
  // every put is a silent no-op — the sweep would download the whole file's
  // clips on EVERY lens entry and store none of them. Don't spend a byte.
  if (!(await audioCacheAvailable())) {
    result.stopped = "cache-unavailable"
    return result
  }

  const order = planWarmOrder(cells, nearCellId)
  if (order.length === 0) return result

  const budget = await audioCacheBudget()
  const getSyncToken = audioSyncTokenFetcherForSession(session)
  let cursor = 0
  let halted: "aborted" | "budget" | "metered" | "slow" | null = null

  const worker = async (workerIndex: number): Promise<void> => {
    while (true) {
      if (halted) return
      if (signal?.aborted) {
        halted = "aborted"
        return
      }
      // Manners check BEFORE claiming an item — a parked worker never holds
      // one. Park (don't exit) for "wait" and for surplus workers, so full
      // speed resumes by itself when playback pauses or the link recovers.
      // (An in-flight fetchCellAudio can't be cancelled — the residual is at
      // most `concurrency` clips overlapping the moment playback starts.)
      const gate = warmGate()
      if (gate.kind === "stop") {
        halted = gate.reason
        return
      }
      if (gate.kind === "wait" || workerIndex >= gate.maxWorkers) {
        if (cursor >= order.length) return // nothing left to wait FOR
        await sleep(YIELD_POLL_MS)
        continue
      }
      const idx = cursor++
      if (idx >= order.length) return
      const target = order[idx]
      try {
        if (await audioCacheHas(target.audioId, target.ext)) {
          result.alreadyCached++
          continue
        }
        // Never evict to warm: once the pantry is nearly full, what's near
        // the user stays hot and the far ends stream instead.
        if ((await audioCacheUsage()) >= budget - budgetHeadroom(budget)) {
          halted = "budget"
          return
        }
        const bytes = await fetchCellAudio({
          projectId,
          fileId: target.fileId,
          audioId: target.audioId,
          ext: target.ext,
          getSyncToken,
        })
        // FORTIFY: bytes already paid for are ALWAYS kept — checking the
        // abort before the put threw away completed downloads on lens exit,
        // only to re-download them on the next entry. The abort still stops
        // the sweep from fetching anything further.
        await audioCachePut(target.audioId, target.ext, bytes)
        result.warmed++
        if (signal?.aborted) {
          halted = "aborted"
          return
        }
      } catch {
        // A missing clip (404) or a transient failure — skip, keep sweeping.
        result.failed++
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)))
  if (halted) result.stopped = halted
  return result
}
