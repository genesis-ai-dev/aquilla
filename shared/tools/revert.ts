/**
 * "Revert everything this tool did since T" — the planning half.
 *
 * Rollback is compensation, never deletion (same rule as the agent undo in
 * src/lib/agent/undo.ts): the plan is a set of NEW events that restore each
 * touched cell's value from before the tool's first write in the window.
 *
 * Skip rule: a cell is only restored while its current head is one of the
 * tool's own writes. If anyone (a person, another tool, an agent) committed on
 * top since, the cell is SKIPPED and listed — their work is never clobbered.
 * Validations the tool added are withdrawn only while they still anchor to the
 * cell's live head.
 */

/** One event the tool wrote inside the window, as the activity read returns it. */
export interface ToolWrite {
  eventId: string
  kind: string
  fileId: string
  cellId: string
  /** Target lane ('' = default lane). */
  targetLang: string
  serverSeq: number
  /** For target.cell.commit: the chain parent the tool committed on. */
  parentId: string | null
  /** For cell.validate / cell.unvalidate: the edit event it anchored to. */
  editEventId?: string | null
  /** Who the tool wrote as (the user running it). */
  author?: string | null
}

/** A touched cell's state now, plus the value from before the tool's first
 *  write in the window. */
export interface TouchedCellState {
  fileId: string
  cellId: string
  targetLang: string
  laneId: string | null
  headEventId: string | null
  headValue: string
  headAuthor: string | null
  sourceEventId: string | null
  /** Value/HTML at the parent of the tool's FIRST commit in the window. */
  priorValue: string
  priorValueHtml: string | null
}

export interface RevertCommit {
  fileId: string
  cellId: string
  targetLang: string
  laneId: string | null
  parentId: string | null
  sourceEventId: string | null
  value: string
  valueHtml: string | null
  before: string
}

export interface RevertUnvalidate {
  fileId: string
  cellId: string
  targetLang: string
  laneId: string | null
  editEventId: string
}

/** A validation the tool WITHDREW, to put back (only the reverting user's
 *  own — a tool can only withdraw its user's validation — and only while it
 *  would anchor to the same, still-live head). */
export interface RevertRevalidate {
  fileId: string
  cellId: string
  targetLang: string
  laneId: string | null
  editEventId: string
}

export interface RevertSkip {
  fileId: string
  cellId: string
  targetLang: string
  reason: "edited-since" | "missing"
  /** Who holds the head now, when known. */
  by: string | null
}

export interface RevertPlan {
  commits: RevertCommit[]
  unvalidates: RevertUnvalidate[]
  revalidates: RevertRevalidate[]
  skipped: RevertSkip[]
  /** Cells whose value already equals the prior value — nothing to do. */
  unchanged: number
}

export function slotKey(fileId: string, cellId: string, targetLang: string): string {
  return `${fileId}\u0000${cellId}\u0000${targetLang}`
}

export function planToolRevert(
  writes: readonly ToolWrite[],
  cells: readonly TouchedCellState[],
  /** The user running the revert (re-validations are only ever theirs). */
  revertingAuthor?: string,
): RevertPlan {
  const commitsBySlot = new Map<string, Set<string>>()
  const validates: ToolWrite[] = []
  // Last validation-state write per slot+anchor: validate or unvalidate.
  const lastVote = new Map<string, ToolWrite>()
  for (const w of writes) {
    const key = slotKey(w.fileId, w.cellId, w.targetLang)
    if (w.kind === "target.cell.commit") {
      const set = commitsBySlot.get(key) ?? new Set<string>()
      set.add(w.eventId)
      commitsBySlot.set(key, set)
    } else if (w.kind === "cell.validate") {
      validates.push(w)
    }
    if ((w.kind === "cell.validate" || w.kind === "cell.unvalidate") && w.editEventId) {
      lastVote.set(`${key}\u0000${w.editEventId}`, w)
    }
  }
  const stateBySlot = new Map(cells.map((c) => [slotKey(c.fileId, c.cellId, c.targetLang), c]))

  const plan: RevertPlan = { commits: [], unvalidates: [], revalidates: [], skipped: [], unchanged: 0 }
  const restoredSlots = new Set<string>()

  for (const [key, toolEventIds] of commitsBySlot) {
    const state = stateBySlot.get(key)
    if (!state) {
      const [fileId, cellId, targetLang] = key.split("\u0000")
      plan.skipped.push({ fileId, cellId, targetLang, reason: "missing", by: null })
      continue
    }
    if (!state.headEventId || !toolEventIds.has(state.headEventId)) {
      plan.skipped.push({
        fileId: state.fileId,
        cellId: state.cellId,
        targetLang: state.targetLang,
        reason: "edited-since",
        by: state.headAuthor,
      })
      continue
    }
    restoredSlots.add(key)
    if (state.headValue === state.priorValue) {
      plan.unchanged++
      continue
    }
    plan.commits.push({
      fileId: state.fileId,
      cellId: state.cellId,
      targetLang: state.targetLang,
      laneId: state.laneId,
      parentId: state.headEventId,
      sourceEventId: state.sourceEventId,
      value: state.priorValue,
      valueHtml: state.priorValueHtml,
      before: state.headValue,
    })
  }

  for (const v of validates) {
    if (!v.editEventId) continue
    const key = slotKey(v.fileId, v.cellId, v.targetLang)
    // The text is being restored → the head the validation anchored to is
    // about to be superseded, which already withdraws it. Only withdraw a
    // validation that still anchors to the live head and stays live.
    if (restoredSlots.has(key) && commitsBySlot.has(key)) {
      const state = stateBySlot.get(key)
      if (state && state.headValue !== state.priorValue) continue
    }
    const state = stateBySlot.get(key)
    if (!state || state.headEventId !== v.editEventId) continue
    plan.unvalidates.push({
      fileId: v.fileId,
      cellId: v.cellId,
      targetLang: v.targetLang,
      laneId: state.laneId,
      editEventId: v.editEventId,
    })
  }
  // A validation the tool removed (its last vote on that anchor was an
  // unvalidate) comes back, if the text it validated is still the live head
  // and nothing above restores a different value.
  for (const w of lastVote.values()) {
    if (w.kind !== "cell.unvalidate" || !w.editEventId) continue
    if (revertingAuthor && w.author && w.author !== revertingAuthor) continue
    const key = slotKey(w.fileId, w.cellId, w.targetLang)
    const state = stateBySlot.get(key)
    if (!state || state.headEventId !== w.editEventId) continue
    if (plan.commits.some((c) => slotKey(c.fileId, c.cellId, c.targetLang) === key)) continue
    plan.revalidates.push({ fileId: w.fileId, cellId: w.cellId, targetLang: w.targetLang, laneId: state.laneId, editEventId: w.editEventId })
  }
  return plan
}
