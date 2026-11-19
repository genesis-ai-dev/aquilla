// Review M1, S1, S2 (question 89 ON: an evened track stays even). Auto-even
// starts ONLY from this tab's own actions on a take (local-take-changes.ts):
// a new recording or attachment, a cut, a trim, a Station version, Remove
// noise. It is handed those takes, waits a moment so one action is one run,
// and evens the ones `autoEvenCandidates` picks. So a Clear, an Undo, a
// colleague's change, another device or opening a file never starts it.
//
// - A take it couldn't even (unmeasurable, refused) is not tried again this
//   session for the same recording and window: no download per edit on a
//   weak network, and a refusal can't loop.
// - It needs a known role of Contributor or up (`allowed`): an unknown role,
//   while it loads, is a no.
// - Runs go through the workspace's one Even out queue (review M2).

import type { CellData } from "@/hooks/useCells"
import { autoEvenCandidates, type EvenOutResult, type TakeRef } from "./even-out"

export interface AutoEvenDeps {
  /** The switch (AUTO_EVEN_CHANGED_TAKES), read by the caller. */
  enabled: boolean
  /** How long to gather one action's takes before running, ms. */
  delayMs?: number
  /** The cells that carry the file's takes, as they read now. */
  cells(): readonly CellData[]
  /** A known role of Contributor or up. */
  allowed(): boolean
  run(takes: readonly TakeRef[]): Promise<EvenOutResult | null>
}

export interface AutoEvenQueue {
  note(refs: readonly TakeRef[]): void
  dispose(): void
}

export function createAutoEvenQueue(deps: AutoEvenDeps): AutoEvenQueue {
  const pending = new Map<string, TakeRef>()
  const tried = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const refKey = (r: TakeRef) => `${r.cellId}\u0000${r.audioId}`

  /** A take as it is now: the same recording and window are the same try. */
  const tryKey = (r: TakeRef, cells: readonly CellData[]) => {
    const a = cells.find((c) => c.id === r.cellId)?.attachments?.[r.audioId]
    return `${refKey(r)}\u0000${a?.url ?? ""}\u0000${a?.trimStartMs ?? 0}\u0000${a?.trimEndMs ?? ""}`
  }

  const flush = () => {
    timer = null
    if (disposed) return
    const refs = [...pending.values()]
    pending.clear()
    if (!deps.enabled || !deps.allowed()) return
    const cells = deps.cells()
    const takes = autoEvenCandidates(cells, refs, true).filter((r) => !tried.has(tryKey(r, cells)))
    if (takes.length === 0) return
    for (const r of takes) tried.add(tryKey(r, cells))
    void deps.run(takes).catch(() => {})
  }

  return {
    note(refs) {
      if (disposed || !deps.enabled || refs.length === 0) return
      for (const r of refs) pending.set(refKey(r), r)
      if (timer == null) timer = setTimeout(flush, deps.delayMs ?? 400)
    },
    dispose() {
      disposed = true
      if (timer != null) clearTimeout(timer)
      timer = null
      pending.clear()
    },
  }
}
