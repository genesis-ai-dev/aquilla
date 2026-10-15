// AQU-1486 — "Validate all repeated rows, or just this one?"
//
// The workspace side of repetition handling. AQU-1391 filled a validated row's
// repetitions and left them unvalidated; this hook keeps that as the "Just
// this row" answer and adds the other one — sign them off too — on every
// gesture that validates a repeated row:
//
//  • the row's validation check   → a dialog (or the remembered answer);
//  • a typed edit, once settled   → never a dialog: the fill toast offers
//                                   "Validate all" (or the remembered answer);
//  • a bulk validation            → one dialog for the whole run, a conflict
//                                   picker where the run's rows disagree, one
//                                   summary toast with one Undo.
//
// The planning is pure (`lib/workflow/repetition-validation.ts`); this hook
// asks, writes, and undoes.

import { useCallback, useRef, useState, type ReactNode } from "react"
import { toast } from "@/components/ui/toast"
import type { ToastSecondaryActionData } from "@/components/ui/toast"
import {
  RepetitionDialogs,
  type RepetitionAnswer,
  type RepetitionPrompt,
} from "@/components/repetition/RepetitionDialogs"
import type { CellData } from "@/hooks/useCells"
import { namedCellRef } from "@/lib/cell-named-ref"
import { useT } from "@/lib/i18n/I18nProvider"
import { getRepetitionChoice, setRepetitionChoice } from "@/lib/store/repetition-choice-pref"
import { emitCellUnvalidate, emitCellValidate, emitTargetCellCommits } from "@/lib/sync/events-emit"
import type { RepetitionCommit } from "@/lib/workflow/repetition-propagation"
import {
  candidateForRule,
  planBulkRepetitionGroups,
  planGroupRepetition,
  planRepetitionValidation,
  repetitionValidationRoom,
  ruleForPick,
  type BulkRepetitionGroup,
  type ConflictRule,
  type RepetitionCandidate,
  type RepetitionChoice,
  type RepetitionGesture,
} from "@/lib/workflow/repetition-validation"

export interface UseRepetitionValidationArgs {
  /** The effective "Auto-propagate repetitions" setting. Off = nothing here runs. */
  enabled: boolean
  projectId: string | undefined
  username: string
  lane: string
  /** May the caller commit target text right now (role, lane not frozen)? */
  canCommit: boolean
  /**
   * May the caller sign the repetitions off? Needs the validate role, the
   * project's validator rules, and "Allow self-validation": the filled rows
   * are the caller's own edits, so with it off the server refuses every vote
   * and "Validate all" is never offered.
   */
  canValidateRepeats: boolean
  /** The open file's cells, read fresh at call time. */
  getCells: () => CellData[]
  /** Not locked by someone else, inside the caller's assigned scope. */
  isWritable: (cell: { id: string; fileId: string }) => boolean
  /** The workspace chain-head resolver (knows commits still in the outbox). */
  resolveParentId: (cell: Pick<CellData, "id" | "targetEventId" | "sourceEventId">) => string | null
  applyOptimisticTargetEdit: (cellId: string, patch: { value: string; valueHtml?: string }) => void
  rememberPendingTargetCommit: (cellId: string, eventId: string, parentId: string | null) => void
  /** Flush the outbox and revalidate after a write. */
  afterWrite: () => Promise<void>
}

/** A validation vote, cast on (and taken back from) one edit. */
export interface RepetitionVote {
  cellId: string
  fileId: string
  editEventId: string
}

interface WrittenFill {
  commit: RepetitionCommit
  eventId: string
}

/** What a bulk run did beyond its own rows, for the summary toast. */
export interface BulkRepetitionOutcome {
  /** Repetitions signed off. */
  validated: number
  /** Repetitions that received text but no vote ("Just these rows", or past the cap). */
  filledOnly: number
  /** Repetitions left alone because their group's translations disagreed. */
  skipped: number
  /** Reverts the whole gesture: the run's votes, the repetitions' votes and fills. */
  undo: (() => Promise<void>) | null
}

export interface BulkRepetitionRun {
  /**
   * Write the planned fills and votes. Call AFTER the run's own votes are in
   * the outbox, passing them, so Undo can take them back too (decision 6).
   */
  apply: (seedVotes: readonly RepetitionVote[]) => Promise<BulkRepetitionOutcome>
}

export interface UseRepetitionValidation {
  /** EditorTable's `onValidated`: one row was validated by `gesture`. */
  handleCellValidated: (cellId: string, gesture?: RepetitionGesture) => Promise<void>
  /**
   * Before a bulk validation writes: ask the reviewer what its repetitions
   * get. Null — synchronously, so a run with no repetitions behaves exactly as
   * it did before AQU-1486 — when nothing in the run repeats outside it.
   */
  prepareBulkRepetitions: (
    seedIds: readonly string[],
    options?: { cap?: number | null },
  ) => Promise<BulkRepetitionRun | null> | null
  /** The toast pieces a bulk run's repetitions add to its summary. */
  bulkToastExtras: (outcome: BulkRepetitionOutcome | null) => {
    note: string | null
    actionProps?: { children: string; onClick: () => void }
  }
  /** Mount once; renders the dialogs while a question is open. */
  dialogs: ReactNode
}

const TOAST_TIMEOUT_MS = 10_000

/**
 * A bulk validation's ONE message (AQU-1503): its own summary, with the note
 * and Undo its repetitions add (AQU-1486). Undo closes the toast it ran from.
 */
export function showBulkValidateToast(
  message: { type: "success" | "info" | "error"; title: string; description?: string },
  extras: ReturnType<UseRepetitionValidation["bulkToastExtras"]>,
): void {
  const description = [message.description, extras.note].filter(Boolean).join(" ")
  const action = extras.actionProps
  const toastId: string = toast.add({
    type: message.type,
    title: message.title,
    ...(description ? { description } : {}),
    ...(action
      ? {
        timeout: TOAST_TIMEOUT_MS,
        actionProps: {
          children: action.children,
          onClick: () => {
            toast.close(toastId)
            action.onClick()
          },
        },
      }
      : {}),
  })
}

/**
 * An Undo runs at most once: a second click would chain a revert on edits that
 * are no longer the rows' heads, and the server would drop it as stale.
 */
function once(run: () => Promise<void>): () => Promise<void> {
  let done = false
  return () => {
    if (done) return Promise.resolve()
    done = true
    return run()
  }
}

export function useRepetitionValidation(args: UseRepetitionValidationArgs): UseRepetitionValidation {
  const {
    enabled, projectId, username, lane, canCommit, canValidateRepeats, getCells, isWritable,
    resolveParentId, applyOptimisticTargetEdit, rememberPendingTargetCommit, afterWrite,
  } = args
  const t = useT()

  // ── Asking ────────────────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState<(RepetitionPrompt & { id: number }) | null>(null)
  const resolverRef = useRef<((answer: RepetitionAnswer) => void) | null>(null)
  const promptSeqRef = useRef(0)

  const ask = useCallback((question: RepetitionPrompt): Promise<RepetitionAnswer> => (
    new Promise((resolve) => {
      // One question at a time. A second validation while the first dialog is
      // open gets the cautious answer rather than a stacked dialog.
      if (resolverRef.current) {
        resolve(question.kind === "choice"
          ? { kind: "choice", choice: "one", remember: false }
          : { kind: "conflict", pick: "skip", applyToRest: false })
        return
      }
      resolverRef.current = resolve
      promptSeqRef.current += 1
      setPrompt({ ...question, id: promptSeqRef.current })
    })
  ), [])

  const onAnswer = useCallback((answer: RepetitionAnswer) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setPrompt(null)
    resolve?.(answer)
  }, [])

  const forgetChoice = useCallback(() => {
    if (projectId) setRepetitionChoice(username, projectId, null)
  }, [projectId, username])

  // ── Writing ───────────────────────────────────────────────────────────────

  /** Emit fills; null (optimistic patch reverted) when the outbox refused them. */
  const writeFills = useCallback(async (
    commits: readonly RepetitionCommit[],
    fromFor: (commit: RepetitionCommit) => string,
  ): Promise<WrittenFill[] | null> => {
    if (!projectId) return null
    if (commits.length === 0) return []
    for (const c of commits) applyOptimisticTargetEdit(c.cellId, { value: c.value, valueHtml: c.valueHtml })
    try {
      const eventIds = await emitTargetCellCommits(commits.map((c) => ({
        projectId,
        fileId: c.fileId,
        cellId: c.cellId,
        parentId: c.parentId,
        sourceEventId: c.sourceEventId,
        value: c.value,
        valueHtml: c.valueHtml,
        author: username,
        targetLang: lane,
        propagatedFromCellId: fromFor(c),
      })))
      commits.forEach((c, i) => rememberPendingTargetCommit(c.cellId, eventIds[i], c.parentId))
      return commits.map((commit, i) => ({ commit, eventId: eventIds[i] }))
    } catch (error) {
      console.warn("[repetition-propagation] enqueue failed:", error)
      for (const c of commits) {
        applyOptimisticTargetEdit(c.cellId, { value: c.previousValue, valueHtml: c.previousValueHtml ?? "" })
      }
      return null
    }
  }, [projectId, username, lane, applyOptimisticTargetEdit, rememberPendingTargetCommit])

  /** Commit each filled row's previous value back, chained on its fill. */
  const revertFills = useCallback(async (fills: readonly WrittenFill[]) => {
    if (!projectId || fills.length === 0) return
    for (const { commit: c } of fills) {
      applyOptimisticTargetEdit(c.cellId, { value: c.previousValue, valueHtml: c.previousValueHtml ?? "" })
    }
    // No `propagatedFromCellId`: the restored text is the cell's own. Explicit
    // '' html: undoing into a cell that had no rich text must CLEAR the html
    // the fill wrote, and an omitted field would leave it standing.
    const undoIds = await emitTargetCellCommits(fills.map(({ commit: c, eventId }) => ({
      projectId,
      fileId: c.fileId,
      cellId: c.cellId,
      parentId: eventId,
      sourceEventId: c.sourceEventId,
      value: c.previousValue,
      valueHtml: c.previousValueHtml ?? "",
      author: username,
      targetLang: lane,
    })))
    fills.forEach(({ commit: c, eventId }, i) => rememberPendingTargetCommit(c.cellId, undoIds[i], eventId))
  }, [projectId, username, lane, applyOptimisticTargetEdit, rememberPendingTargetCommit])

  const castVotes = useCallback(async (votes: readonly RepetitionVote[], validated: boolean) => {
    if (!projectId) return
    const emit = validated ? emitCellValidate : emitCellUnvalidate
    for (const v of votes) {
      await emit({
        projectId,
        fileId: v.fileId,
        cellId: v.cellId,
        editEventId: v.editEventId,
        author: username,
        targetLang: lane,
        surface: "repetition",
      })
    }
  }, [projectId, username, lane])

  /**
   * The votes for `validateIds`: a filled row's on its fill; an untouched
   * identical row's on its current edit (pending outbox head first).
   */
  const votesFor = useCallback((
    validateIds: readonly string[],
    fills: readonly WrittenFill[],
  ): RepetitionVote[] => {
    const fillEvent = new Map(fills.map((f) => [f.commit.cellId, f.eventId]))
    const byId = new Map(getCells().map((c) => [c.id, c]))
    const votes: RepetitionVote[] = []
    for (const id of validateIds) {
      const cell = byId.get(id)
      if (!cell) continue
      const head = resolveParentId(cell)
      const editEventId = fillEvent.get(id) ?? (head && head !== cell.sourceEventId ? head : null)
      if (editEventId) votes.push({ cellId: id, fileId: cell.fileId, editEventId })
    }
    return votes
  }, [getCells, resolveParentId])

  const undoGesture = useCallback(async (
    votesToTakeBack: readonly RepetitionVote[],
    fills: readonly WrittenFill[],
  ) => {
    try {
      // A filled row's vote dies with the revert commit (a vote only sticks to
      // the latest edit); every other vote is taken back explicitly.
      const filled = new Set(fills.map((f) => f.commit.cellId))
      await castVotes(votesToTakeBack.filter((v) => !filled.has(v.cellId)), false)
      await revertFills(fills)
      await afterWrite()
    } catch (error) {
      console.warn("[repetition-propagation] undo failed:", error)
      toast.add({ type: "error", title: t("editor.repetition.undoFailed") })
    }
  }, [castVotes, revertFills, afterWrite, t])

  const askEachTimeAction = useCallback((): ToastSecondaryActionData => ({
    label: t("editor.repetition.askEachTime"),
    onClick: forgetChoice,
  }), [t, forgetChoice])

  /** A report toast whose Undo runs once and closes it. */
  const addUndoToast = useCallback((
    options: { title: string; secondaryAction?: ToastSecondaryActionData | null },
    undo: () => Promise<void>,
  ) => {
    const run = once(undo)
    const { title, secondaryAction } = options
    const toastId: string = toast.add({
      title,
      timeout: TOAST_TIMEOUT_MS,
      actionProps: {
        children: t("editor.repetition.undo"),
        onClick: () => {
          toast.close(toastId)
          void run()
        },
      },
      ...(secondaryAction ? { data: { secondaryAction } } : {}),
    })
  }, [t])

  // ── One row ───────────────────────────────────────────────────────────────

  const planFor = useCallback((seedId: string) => planRepetitionValidation({
    seedId,
    cells: getCells(),
    username,
    isWritable,
    resolveParentId,
  }), [getCells, username, isWritable, resolveParentId])

  /** Fill and sign off; `earlierFills` came from a typed edit's fill toast. */
  const validateAll = useCallback(async (
    seedId: string,
    { viaMemory, earlierFills = [] }: { viaMemory: boolean; earlierFills?: readonly WrittenFill[] },
  ) => {
    const plan = planFor(seedId)
    const fills = await writeFills(plan.fills, () => seedId)
    if (fills === null) return
    const votes = votesFor(plan.validateIds, fills)
    try {
      await castVotes(votes, true)
    } catch (error) {
      console.warn("[repetition-propagation] validate failed:", error)
      toast.add({ type: "error", title: t("editor.repetition.validateFailed") })
    }
    await afterWrite()
    if (votes.length === 0) return
    const allFills = [...earlierFills, ...fills]
    addUndoToast(
      {
        title: t("editor.repetition.validated", { count: votes.length }),
        secondaryAction: viaMemory ? askEachTimeAction() : null,
      },
      () => undoGesture(votes, allFills),
    )
  }, [planFor, writeFills, votesFor, castVotes, afterWrite, undoGesture, askEachTimeAction, addUndoToast, t])

  /** AQU-1391's fill, with the toast this gesture calls for. */
  const fillOnly = useCallback(async (
    seedId: string,
    { offerValidateAll, viaMemory }: { offerValidateAll: boolean; viaMemory: boolean },
  ) => {
    const plan = planFor(seedId)
    const fills = await writeFills(plan.fills, () => seedId)
    if (fills === null) return
    if (fills.length > 0) await afterWrite()
    const secondaryAction: ToastSecondaryActionData | null = offerValidateAll && plan.validateIds.length > 0
      ? {
        label: t("editor.repetition.validateAll"),
        onClick: () => { void validateAll(seedId, { viaMemory: false, earlierFills: fills }) },
      }
      : viaMemory ? askEachTimeAction() : null
    if (fills.length === 0) {
      // Nothing to fill, but identical repeats still wait for a vote: say so
      // only when the toast can do something about it.
      if (!secondaryAction || !offerValidateAll) return
      toast.add({
        title: t("editor.repetition.unvalidatedRepeats", { count: plan.validateIds.length }),
        timeout: TOAST_TIMEOUT_MS,
        data: { secondaryAction },
      })
      return
    }
    addUndoToast(
      { title: t("editor.repetition.applied", { count: fills.length }), secondaryAction },
      () => undoGesture([], fills),
    )
  }, [planFor, writeFills, afterWrite, validateAll, askEachTimeAction, undoGesture, addUndoToast, t])

  const handleCellValidated = useCallback(async (cellId: string, gesture: RepetitionGesture = "typed") => {
    if (!enabled || !projectId || !canCommit) return
    const plan = planFor(cellId)
    if (plan.fills.length === 0 && plan.validateIds.length === 0) return
    const mayValidate = canValidateRepeats && plan.validateIds.length > 0
    const remembered = mayValidate ? getRepetitionChoice(username, projectId) : null

    // A typed edit never opens a dialog. A remembered "all" still applies to
    // it; a remembered "one" is what a typed edit does anyway, and its toast
    // keeps offering "Validate all".
    if (gesture === "typed") {
      if (remembered === "all") await validateAll(cellId, { viaMemory: true })
      else await fillOnly(cellId, { offerValidateAll: mayValidate, viaMemory: false })
      return
    }

    let choice: RepetitionChoice = remembered ?? "one"
    if (mayValidate && !remembered) {
      const answer = await ask({ kind: "choice", scope: "single", repeatCount: plan.validateIds.length, room: null })
      if (answer.kind === "choice") {
        choice = answer.choice
        if (answer.remember) setRepetitionChoice(username, projectId, answer.choice)
      }
    }
    if (choice === "all") await validateAll(cellId, { viaMemory: remembered !== null })
    else await fillOnly(cellId, { offerValidateAll: false, viaMemory: remembered !== null })
  }, [enabled, projectId, canCommit, canValidateRepeats, username, planFor, validateAll, fillOnly, ask])

  // ── Bulk ──────────────────────────────────────────────────────────────────

  /** The asking half of a bulk run, once there is something to ask about. */
  const askBulk = useCallback(async (
    projectId: string,
    seedIds: readonly string[],
    cells: readonly CellData[],
    groups: readonly BulkRepetitionGroup[],
    cap: number | null | undefined,
  ): Promise<BulkRepetitionRun> => {
    // The dialog's number sizes conflicting groups by their first translation;
    // it is the count the reviewer is deciding about, not a promise per row.
    const estimate = groups.reduce((n, group) => n + planGroupRepetition({
      group, candidate: group.candidates[0], username, resolveParentId,
    }).validateIds.length, 0)
    const room = repetitionValidationRoom(cap, seedIds.length)
    const mayValidate = canValidateRepeats && estimate > 0 && room !== 0

    let choice: RepetitionChoice = "one"
    if (mayValidate) {
      const remembered = getRepetitionChoice(username, projectId)
      if (remembered) {
        choice = remembered
      } else {
        const answer = await ask({ kind: "choice", scope: "bulk", repeatCount: estimate, room })
        if (answer.kind === "choice") {
          choice = answer.choice
          if (answer.remember) setRepetitionChoice(username, projectId, answer.choice)
        }
      }
    }

    // Decision 5: where the run's rows disagree, the reviewer picks the text.
    const byId = new Map(cells.map((c) => [c.id, c]))
    const position = new Map(cells.map((c, i) => [c.id, i + 1]))
    const rowName = (id: string): string => {
      const cell = byId.get(id)
      const ref = cell ? namedCellRef(cell) : undefined
      if (ref) return ref
      const number = position.get(id)
      return number === undefined ? "" : t("editor.repetition.conflictRowName", { number })
    }
    const conflictCount = groups.filter((g) => g.candidates.length > 1).length
    const decisions: Array<{ group: BulkRepetitionGroup; candidate: RepetitionCandidate | null }> = []
    let rule: ConflictRule | null = null
    let asked = 0
    for (const group of groups) {
      if (group.candidates.length === 1) {
        decisions.push({ group, candidate: group.candidates[0] })
        continue
      }
      if (rule) {
        decisions.push({ group, candidate: candidateForRule(group, rule) })
        continue
      }
      asked += 1
      const answer = await ask({
        kind: "conflict",
        source: byId.get(group.candidates[0].cellIds[0])?.original ?? "",
        candidates: group.candidates.map((c) => ({
          text: c.value,
          rows: c.cellIds.map(rowName).filter((name) => name !== ""),
        })),
        targetCount: group.targets.length,
        canApplyToRest: asked < conflictCount,
      })
      const pick = answer.kind === "conflict" ? answer.pick : "skip"
      decisions.push({ group, candidate: pick === "skip" ? null : group.candidates[pick] ?? null })
      if (answer.kind === "conflict" && answer.applyToRest) rule = ruleForPick(group, pick)
    }

    return {
      apply: async (seedVotes) => {
        // Re-read: the run's own votes and anything else that landed while the
        // dialogs were open. A target that has since been validated, locked or
        // left the file is dropped.
        const current = new Map(getCells().map((c) => [c.id, c]))
        const fills: RepetitionCommit[] = []
        const fromCell = new Map<string, string>()
        const validateIds: string[] = []
        let skipped = 0
        for (const { group, candidate } of decisions) {
          const targets = group.targets
            .map((target) => current.get(target.id))
            .filter((c): c is CellData => c !== undefined && c.status !== "validated" && isWritable(c))
          if (!candidate) {
            skipped += targets.length
            continue
          }
          const plan = planGroupRepetition({ group: { ...group, targets }, candidate, username, resolveParentId })
          for (const commit of plan.fills) {
            fills.push(commit)
            fromCell.set(commit.cellId, candidate.cellIds[0])
          }
          validateIds.push(...plan.validateIds)
        }
        const written = await writeFills(fills, (c) => fromCell.get(c.cellId) ?? c.cellId)
        if (written === null) return { validated: 0, filledOnly: 0, skipped, undo: null }

        // Decision 7: repetition votes count toward the batch size.
        const allowed = choice === "all"
          ? (room === null ? validateIds : validateIds.slice(0, room))
          : []
        const votes = votesFor(allowed, written)
        try {
          await castVotes(votes, true)
        } catch (error) {
          console.warn("[repetition-propagation] validate failed:", error)
        }
        const voted = new Set(votes.map((v) => v.cellId))
        const filledOnly = written.filter((f) => !voted.has(f.commit.cellId)).length
        const touched = written.length > 0 || votes.length > 0
        return {
          validated: votes.length,
          filledOnly,
          skipped,
          undo: touched ? once(() => undoGesture([...seedVotes, ...votes], written)) : null,
        }
      },
    }
  }, [canValidateRepeats, getCells, isWritable, username, resolveParentId, ask, t, writeFills, votesFor, castVotes, undoGesture])

  const prepareBulkRepetitions = useCallback((
    seedIds: readonly string[],
    options: { cap?: number | null } = {},
  ): Promise<BulkRepetitionRun | null> | null => {
    if (!enabled || !projectId || !canCommit || seedIds.length === 0) return null
    const cells = getCells()
    const groups = planBulkRepetitionGroups({ seedIds, cells, isWritable })
    if (groups.length === 0) return null
    return askBulk(projectId, seedIds, cells, groups, options.cap)
  }, [enabled, projectId, canCommit, getCells, isWritable, askBulk])

  const bulkToastExtras = useCallback((outcome: BulkRepetitionOutcome | null) => {
    if (!outcome) return { note: null }
    const notes = [
      outcome.validated > 0 ? t("editor.repetition.bulkValidatedNote", { count: outcome.validated }) : null,
      outcome.filledOnly > 0 ? t("editor.repetition.bulkFilledNote", { count: outcome.filledOnly }) : null,
      outcome.skipped > 0 ? t("editor.repetition.bulkSkippedNote", { count: outcome.skipped }) : null,
    ].filter((note): note is string => note !== null)
    const undo = outcome.undo
    return {
      note: notes.length > 0 ? notes.join(" ") : null,
      ...(undo
        ? { actionProps: { children: t("editor.repetition.undo"), onClick: () => { void undo() } } }
        : {}),
    }
  }, [t])

  return {
    handleCellValidated,
    prepareBulkRepetitions,
    bulkToastExtras,
    dialogs: <RepetitionDialogs prompt={prompt} onAnswer={onAnswer} />,
  }
}
