// Floating action bar that appears whenever the user has multi-selected
// cells. Surfaces bulk Translate / Validate / Generate Audio / Both.
//
// Synth uses the project's default voice; per-voice generation and the voice
// library live in the Voice Studio.

// Phase 2c-gamma: bulk synth + Y.Doc-driven validate are gone. The
// selection bar still surfaces the count + Translate (via completeBatch,
// which now drives the LLM stream without writing the result back) so the
// multi-select UX stays useful. Validate and Speak/Translate+Speak are
// disabled until the audio-attachment + validate-via-events grammars land.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Languages, Sparkles, Wand2, X } from "lucide-react"
import { toast } from "@/components/ui/toast"
import { Spinner } from "@/components/ui/spinner"
import type { CellData } from "@/hooks/useCells"
import { type CellStore, readAtVersion, useCellStoreVersion } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { clearSelection, MAX_SELECTED, useSelectedIds } from "@/lib/audio/selection"
import { emitCellValidate, emitCellUnvalidate, emitCellAudioValidate, emitCellAudioUnvalidate } from "@/lib/sync/events-emit"
import { useAudioValidationCommit } from "@/lib/audio/audio-validation-commit"
import { isBulkAudioValidatableByMe, isBulkAudioUnvalidatableByMe } from "@/lib/review/bulk-audio-validation"
import { fileHasAudio as fileHasAnyAudio } from "@/lib/audio/file-has-audio"
import { mergeCellsWithAudio } from "@/hooks/useFileAudioAttachments"
import { audioEntryFromCell, audioValidationTakes } from "@/lib/audio/audio-validation-permissions"
import type { LinkedTake } from "@/lib/audio/linked-takes"
import { canPerform } from "@/lib/sync/role-policy"
import { isBulkValidationEligible } from "@/lib/review/review-eligibility"
import { isBulkValidatableByMe } from "@/lib/review/bulk-validation"
import { isOwnTextEdit, textValidationScope } from "@/lib/review/text-validation-policy"
import { isInMemberScope, type MemberScope } from "@/lib/sync/member-scopes"
import { useT } from "@/lib/i18n/I18nProvider"
import { categorizeAiError, type ErrorCategory } from "@/lib/audio/ai-error"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useFormat } from "@/lib/i18n/format"
import {
  batchValidateSkipClauses,
  batchValidateTelemetry,
  batchValidateToast,
  noPermissionMessage,
  summarizeBatchValidate,
} from "@/lib/review/batch-validate-summary"
import { namedCellRef } from "@/lib/cell-named-ref"
import { BATCH_VALIDATE_ATTEMPTED } from "@/lib/event-names"
import posthog from "@/lib/posthog"
import { reportQueued, reportValidation } from "@/lib/review-telemetry"

/** "Voice together" failures whose usual body speaks of ONE line, in the
 *  words that fit the several lines this action voices. */
/** Lines the partial "Validate text" hover names before "and N more". */
const PARTIAL_REFS_SHOWN = 8

const VOICE_TOGETHER_ENGINE_BODY: Partial<Record<ErrorCategory, MessageKey>> = {
  "hosted-tts-not-configured": "editor.selection.voiceTogetherInworldNotConfigured",
  "hosted-tts-failed": "editor.selection.voiceTogetherInworldFailed",
  "seed-vc-not-configured": "editor.selection.voiceTogetherSeedVcNotConfigured",
  "seed-vc-failed": "editor.selection.voiceTogetherSeedVcFailed",
}

interface Props {
  project: ProjectRecord
  cellStore: CellStore
  session: FrontierSession | null
  username: string
  /**
   * AQU-538/AQU-633: the active target lane. Bulk validate/unvalidate must
   * carry it as `targetLang` so the events land on the correct lane's chain
   * slot and pass the sync-worker's lane-scope gate — matching the single-cell
   * path (EditorTable.emitValidationChange) and ProjectWorkspace.runBatchValidate.
   * `''` = default lane and is omitted on the wire by the emit helpers.
   */
  activeLane: string
  /**
   * AQU-633: the current user's own lane/file scopes (empty = unscoped). Bulk
   * validate/unvalidate skip cells outside these scopes so a scoped member
   * never fires a guaranteed-403; the server stays authoritative.
   */
  myScopes: MemberScope[]
  /**
   * AQU-490: the file's audio, so bulk validation can see the takes. The
   * selection reads cells straight from the store, which never carry
   * attachments — without this the audio action would find nothing to do on
   * every file, silently.
   */
  audioByCellId?: Parameters<typeof mergeCellsWithAudio>[1]
  /**
   * The heard lines performing each subtitle line, in a dubbing file — where
   * the takes of the selected lines actually live (Sam, 2026-09-30). Without
   * it a selection of subtitle lines found no takes at all.
   */
  linkedTakesByCell?: ReadonlyMap<string, readonly LinkedTake[]>
  completeSingle?: (cell: CellData) => Promise<boolean> | void
  completeBatch?: (cells: CellData[]) => Promise<void> | void
  /** Audio mode surfaces "Voice together" instead of Translate/Validate. */
  audioMode?: boolean
  /** Synthesize the selected cells as one continuous clip + slice per cell. */
  onVoiceTogether?: (cells: CellData[]) => Promise<void> | void
  /**
   * AQU-186: called when the user clicks "Harmonize…" on the selection bar.
   * Receives the subset of selected cells that have at least one active
   * fix-review proposal. The parent opens FixReviewPanel in multi-cell scope.
   * Optional — when absent the button is not rendered.
   */
  onHarmonize?: (cells: CellData[]) => void
  /**
   * AQU-186: whether the current user has the harmonize_min_role.
   * When false, the button is disabled (server is still authoritative).
   */
  canHarmonize?: boolean
  /**
   * AQU-616: called right after a bulk validate/unvalidate enqueues its events,
   * so the parent can flush the outbox immediately + revalidate. Without this,
   * bulk validations sit in the outbox until the periodic ~5s flusher drains
   * them, so the "Queued → Synced" confirm lags for seconds even though the
   * icon updates optimistically. Every other validate path already flushes on
   * commit; this closes that gap.
   */
  onValidationCommitted?: () => void
  /**
   * The org's `allowBulkValidateAiDrafts`: true lets "Validate text" sign off
   * untouched AI drafts too. Absent or false keeps the one-at-a-time rule —
   * the same value reaches the file menu's "Batch validate text…", so the two
   * bulk paths always agree.
   */
  allowBulkValidateAiDrafts?: boolean
}

type Running =
  | { kind: "idle" }
  | { kind: "translate" }
  | { kind: "validate" }
  | { kind: "voice" }
  | { kind: "validate-audio" }

export function SelectionBar({ project, cellStore, session, username, activeLane, myScopes, audioByCellId, linkedTakesByCell, completeBatch, audioMode, onVoiceTogether, onHarmonize, canHarmonize = true, onValidationCommitted, allowBulkValidateAiDrafts = false }: Props) {
  const t = useT()
  // AQU-1503: skip clauses join the way a list is written in the reader's
  // language rather than with a hardcoded separator.
  const { list: formatLocaleList } = useFormat()
  const selected = useSelectedIds()
  const cellStoreVersion = useCellStoreVersion(cellStore)
  const [running, setRunning] = useState<Running>({ kind: "idle" })
  const commitAudioValidation = useAudioValidationCommit(session?.jwt ?? null)

  useEffect(() => {
    if (selected.size === 0) return
    const onKey = (e: KeyboardEvent) => {
      // Don't steal Esc when the user is typing/editing — those handlers run
      // first and clear focus naturally. Only act when no editable element
      // is focused.
      if (e.key !== "Escape") return
      const ae = document.activeElement
      const editing = ae instanceof HTMLElement &&
        (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")
      if (editing) return
      clearSelection()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selected.size])

  const selectedCells = useMemo(() => {
    return readAtVersion(cellStoreVersion, () => cellStore.getCellsByIds(selected).slice(0, MAX_SELECTED))
  }, [cellStore, cellStoreVersion, selected])

  const missingCount = useMemo(
    () => selectedCells.filter((c) => !c.translated.trim() && c.original?.trim()).length,
    [selectedCells],
  )
  // AQU-1571: the project's minimum role and named-validator list, which the
  // server enforces on every text vote. A reader they exclude can validate
  // nothing here, so the count is zero and the button says why.
  const textScope = textValidationScope(project, {
    roleLevel: project.syncRole?.level ?? null,
    username,
  })
  const textScopeCanValidate = textScope.canValidate
  // Which rule shut the reader out: "your role" is wrong advice for someone
  // the named-validator list leaves out, whose role is fine.
  const noPermissionReason = textScope.reason === "allowlist" ? "allowlist" : "role"
  const allowSelfValidation = project.allowSelfValidation
  const validatableCount = useMemo(
    // AQU-490: shared with ProjectWorkspace.runBatchValidate, which used to
    // apply neither of these two guards.
    () => !textScopeCanValidate ? 0 : selectedCells.filter((c) =>
      isBulkValidatableByMe(c, username, myScopes, activeLane, {
        allowAiDrafts: allowBulkValidateAiDrafts,
        allowSelfValidation,
      }),
    ).length,
    [selectedCells, username, myScopes, activeLane, allowBulkValidateAiDrafts, allowSelfValidation, textScopeCanValidate],
  )
  const unvalidatableCount = useMemo(
    () => selectedCells.filter(
      (c) => c.translated.trim() && c.activeValidators.includes(username),
    ).length,
    [selectedCells, username],
  )
  // When nothing is validatable, explain the actual reason rather than always
  // blaming AI drafts. Priority: everything already validated by me → AI
  // drafts needing individual review → cells still lacking a translation.
  const validateDisabledReason = useMemo(() => {
    if (validatableCount > 0) return null
    if (!textScopeCanValidate) return noPermissionMessage({ noPermissionReason }, t)
    const policy = { allowAiDrafts: allowBulkValidateAiDrafts }
    // AQU-633: cells eligible + not-yet-mine but blocked only by scope.
    const outOfScope = selectedCells.filter(
      (c) =>
        isBulkValidationEligible(c, policy) &&
        !c.activeValidators.includes(username) &&
        !isInMemberScope(myScopes, c.fileId, activeLane),
    ).length
    if (outOfScope > 0) {
      return t("editor.selection.validateOutOfScope")
    }
    const alreadyMine = selectedCells.filter(
      (c) => isBulkValidationEligible(c, policy) && c.activeValidators.includes(username),
    ).length
    // Where the org lets drafts through, they are never the reason: a draft
    // is then held back only by scope or by being already mine, both above.
    const aiDrafts = allowBulkValidateAiDrafts ? 0 : selectedCells.filter(
      (c) => c.translated.trim() && c.targetEventId && c.aiDrafted,
    ).length
    const needTranslation = selectedCells.filter((c) => !c.translated.trim()).length
    // AQU-1571: lines whose latest change is the reader's own, on a project
    // that wants someone else to validate them. Ahead of the AI-draft reason:
    // the reader's own draft is refused one at a time too.
    const isOwnEdit = (c: CellData) =>
      Boolean(c.translated.trim()) &&
      Boolean(c.targetEventId) &&
      !c.activeValidators.includes(username) &&
      isOwnTextEdit(c, username, allowSelfValidation)
    const ownEdits = selectedCells.filter(isOwnEdit).length
    if (alreadyMine > 0 && ownEdits === 0 && aiDrafts === 0 && needTranslation === 0) {
      return t("editor.selection.validateAllMine")
    }
    // "These cells are yours" only when every selected line is. In a mixed
    // selection that sentence is false for the rest, and it hid the reason the
    // reader could act on: another person's AI draft is the org's rule to
    // relax, so that reason leads.
    if (ownEdits > 0 && ownEdits === selectedCells.length) return t("editor.selection.validateOwnEdits")
    const othersAiDrafts = aiDrafts === 0 ? 0 : selectedCells.filter(
      (c) => c.translated.trim() && c.targetEventId && c.aiDrafted && !isOwnEdit(c),
    ).length
    if (ownEdits > 0 && othersAiDrafts === 0) return t("editor.selection.validateOwnEditsSome")
    // The rule is the org's to relax, so say where — a greyed-out button with
    // no way forward is how this read to Sam on 2026-10-01.
    if (aiDrafts > 0) {
      // One column: the tooltip lays its children out in a row, so two
      // siblings stood side by side as two narrow columns.
      return (
        <span className="flex flex-col gap-1">
          <span>{t("editor.selection.validateAiDrafts")}</span>
          <span>{t("editor.selection.validateAiDraftsOrgHint")}</span>
        </span>
      )
    }
    if (needTranslation > 0) return t("editor.selection.validateNeedTranslation")
    return t("editor.selection.validateNothingEligible")
  }, [validatableCount, selectedCells, username, myScopes, activeLane, allowBulkValidateAiDrafts, allowSelfValidation, textScopeCanValidate, noPermissionReason, t])
  // When the click would sign off only part of the selection, the hover says
  // which lines and why it leaves the rest. A badge of 3 on ten selected lines
  // used to explain itself only in the toast after the click (Sam,
  // 2026-10-03). Built from the same summary the click runs, so the two
  // cannot disagree.
  const validatePartialTooltip = useMemo(() => {
    if (validatableCount === 0) return null
    const summary = summarizeBatchValidate(selectedCells, {
      username,
      myScopes,
      activeLane,
      hasTarget: Boolean(project.id),
      canValidate: textScopeCanValidate,
      noPermissionReason,
      allowAiDrafts: allowBulkValidateAiDrafts,
      allowSelfValidation,
    })
    if (summary.outcome !== "partial") return null
    const count = summary.validatable.length
    const total = selectedCells.length
    const signedOff = new Set(summary.validatable)
    const refs = selectedCells.filter((c) => signedOff.has(c)).map(namedCellRef)
    // Rows without a reference are numbered by their place in the table,
    // which this bar does not know; then the lines go unnamed rather than
    // half-named.
    const named = refs.every((ref): ref is string => Boolean(ref))
      ? refs as string[]
      : null
    const shown = named && named.length > PARTIAL_REFS_SHOWN
      ? [
        ...named.slice(0, PARTIAL_REFS_SHOWN - 1),
        t("editor.selection.validatePartialMoreRefs", { count: named.length - (PARTIAL_REFS_SHOWN - 1) }),
      ]
      : named
    return (
      <span className="flex flex-col gap-1">
        <span>
          {shown
            ? t("editor.selection.validatePartialNamed", { count, total, refs: formatLocaleList(shown, { type: "conjunction" }) })
            : t("editor.selection.validatePartial", { count, total })}
        </span>
        <span>
          {t("editor.selection.validatePartialSkips", {
            count: summary.skippedTotal + summary.cappedOut,
            reasons: formatLocaleList(batchValidateSkipClauses(summary, t)),
          })}
        </span>
      </span>
    )
  }, [validatableCount, selectedCells, username, myScopes, activeLane, project.id, textScopeCanValidate, noPermissionReason, allowBulkValidateAiDrafts, allowSelfValidation, t, formatLocaleList])
  const allHaveTranslation = selectedCells.length > 0 && selectedCells.every((c) => c.translated.trim())
  const voiceableCount = useMemo(
    () => selectedCells.filter((c) => c.type !== "paratext" && c.translated.trim()).length,
    [selectedCells],
  )
  // AQU-186: cells with at least one infraction or fix proposal — v1 minimum:
  // show affordance when ≥ 1 selected cell has a translated value (proxy for
  // "may have violations"; real infraction data wires in when worker lands).
  const harmonizableCount = useMemo(
    () => selectedCells.filter((c) => c.translated.trim()).length,
    [selectedCells],
  )
  const isBusy = running.kind !== "idle"

  /**
   * AQU-1459: the SAME permission `commitCompletedCells` applies, asked BEFORE
   * the model is called instead of after it answers. A validator (Reviewer)
   * passes the `cell.validate` check that keeps the whole bar on screen, so
   * Translate used to stay live for them: the click spent tokens on drafts the
   * commit then refused with "You do not have permission to commit target
   * cells". The header's Run completions / Complete all already gate on this
   * (`workspace-actions/registry.ts`); this is the affordance that did not.
   *
   * `canPerform` fails OPEN on an unknown role, so local/legacy projects with
   * no `syncRole` keep Translate — same convention as the suppression check
   * below. `project.syncRole` is re-read on every render, so a role downgrade
   * or lane grant that lands through the app's usual refresh takes effect here
   * without a reload.
   */
  const roleLevel = project.syncRole?.level ?? null
  const canCommitTarget = canPerform("target.cell.commit", roleLevel)

  // AQU-490: bulk AUDIO validation — a SEPARATE action beside the text one,
  // per Sam's ruling. Never merged: a reviewer signing off translations has
  // not listened to the recordings, and one button doing both would collect
  // sign-off nobody meant to give.
  /**
   * The selection's takes, split into what I can still give and what I can
   * take back. One pass, because both halves walk the same merged cells and
   * ask the same adapter — and because a second pass is how the two counts
   * would eventually disagree about the same take.
   */
  const { audioTakeTargets, audioRemoveTargets, audioHasAnyTake } = useMemo(() => {
    const give: Array<{ fileId: string; cellId: string; audioId: string }> = []
    const back: Array<{ fileId: string; cellId: string; audioId: string }> = []
    if (!audioByCellId && !linkedTakesByCell) return { audioTakeTargets: give, audioRemoveTargets: back, audioHasAnyTake: false }
    let anyTake = false
    // A heard line performing two selected lines is one take, voted once.
    const seen = new Set<string>()
    // `row` is the selected line, whose file the viewer's scope is asked
    // about — an assignment is to the subtitle file, never to its hidden cue
    // sibling. `owner` is the cell the take lives on: the row itself, or a
    // heard line performing it.
    const visit = (row: CellData, owner: CellData) => {
      for (const take of audioValidationTakes(
        audioEntryFromCell(owner),
        project,
        { roleLevel: project.syncRole?.level ?? null, username },
        () => "",
      )) {
        const key = `${owner.id}|${take.audioId}`
        if (seen.has(key)) continue
        seen.add(key)
        anyTake = true
        const target = { fileId: owner.fileId, cellId: owner.id, audioId: take.audioId }
        if (isBulkAudioValidatableByMe(row, take, username, myScopes, activeLane)) give.push(target)
        if (isBulkAudioUnvalidatableByMe(row, take, username, myScopes, activeLane)) back.push(target)
      }
    }
    const merged = audioByCellId ? mergeCellsWithAudio(selectedCells, audioByCellId) : selectedCells
    for (const cell of merged) {
      visit(cell, cell)
      for (const heard of linkedTakesByCell?.get(cell.id) ?? []) {
        if (heard.hasTake) visit(cell, heard.cell)
      }
    }
    return { audioTakeTargets: give, audioRemoveTargets: back, audioHasAnyTake: anyTake }
  }, [selectedCells, audioByCellId, linkedTakesByCell, myScopes, activeLane, project, username])

  /**
   * Does this FILE have audio at all? The pair's presence turns on this rather
   * than on the selection: Sam's ruling of 2026-09-22 is that the buttons never
   * disappear once you are working with audio, only enable and disable. Keying
   * on the selection is what made "Validate audio" vanish the moment you used
   * it — the very click that emptied it also hid the way back.
   *
   * A text-only file still shows only the text pair, so nothing grows two dead
   * buttons it can never use. The same rule draws the editor gutter's audio
   * column (AQU-1495), so the two can never disagree about a file.
   */
  const fileHasAudio = useMemo(
    () => fileHasAnyAudio(audioByCellId, linkedTakesByCell),
    [audioByCellId, linkedTakesByCell],
  )

  /** Why the validate button is dark, in the selection's own terms. */
  const validateAudioDisabledReason = useMemo(() => {
    if (audioTakeTargets.length > 0) return null
    if (!audioHasAnyTake) return t("editor.selection.validateAudioNoTakes")
    if (audioRemoveTargets.length > 0) return t("editor.selection.validateAudioAllMine")
    return t("editor.selection.validateAudioNothingEligible")
  }, [audioTakeTargets, audioRemoveTargets, audioHasAnyTake, t])

  const onValidateAudio = useCallback(async () => {
    if (isBusy || audioTakeTargets.length === 0) return
    if (!canPerform("cell.audio.validate", project.syncRole?.level ?? null)) return
    setRunning({ kind: "validate-audio" })
    // AQU-1572: one event for the whole selection, counting the votes that
    // reached the outbox even when a later one throws.
    const voted: typeof audioTakeTargets = []
    try {
      // AWAITED, unlike the text loop beside it. These are not fire-and-forget
      // here because the commit below flushes the outbox, and a flush that
      // outruns its own enqueues sends nothing (AQU-490, 2026-09-22).
      for (const target of audioTakeTargets) {
        await emitCellAudioValidate({
          projectId: project.id,
          fileId: target.fileId,
          cellId: target.cellId,
          audioId: target.audioId,
          ...(activeLane ? { targetLang: activeLane } : {}),
          author: username,
        })
        voted.push(target)
      }
      toast.add({
        type: "success",
        title: t("editor.selection.validatedAudioToast", { count: audioTakeTargets.length }),
      })
      // NOT `onValidationCommitted` — that is the TEXT refresher, and routing
      // audio through it is why the gutter stayed hollow after a bulk vote.
      // Every file the selection touched, because a subtitle selection's takes
      // can live on a cue sibling.
      await commitAudioValidation(audioTakeTargets.map((target) => target.fileId))
    } finally {
      reportValidation({
        medium: "audio", validated: true, projectId: project.id, cells: voted,
        lane: activeLane, source: "ui", surface: "selection",
      })
      setRunning({ kind: "idle" })
    }
  }, [audioTakeTargets, isBusy, project, username, commitAudioValidation, t, activeLane])

  /** The opposite action, which the audio side simply did not have. */
  const onUnvalidateAudio = useCallback(async () => {
    if (isBusy || audioRemoveTargets.length === 0) return
    if (!canPerform("cell.audio.unvalidate", project.syncRole?.level ?? null)) return
    setRunning({ kind: "validate-audio" })
    const withdrawn: typeof audioRemoveTargets = []
    try {
      for (const target of audioRemoveTargets) {
        // No `targetUsername`: absent means "my own vote", and removing
        // somebody else's is a maintainer action that lives elsewhere.
        // AQU-1462 stamps the lane so an archived lane can refuse the vote.
        // The vote itself stays shared across languages.
        await emitCellAudioUnvalidate({
          projectId: project.id,
          fileId: target.fileId,
          cellId: target.cellId,
          audioId: target.audioId,
          ...(activeLane ? { targetLang: activeLane } : {}),
          author: username,
        })
        withdrawn.push(target)
      }
      toast.add({
        type: "success",
        title: t("editor.selection.unvalidatedAudioToast", { count: audioRemoveTargets.length }),
      })
      await commitAudioValidation(audioRemoveTargets.map((target) => target.fileId))
    } finally {
      reportValidation({
        medium: "audio", validated: false, projectId: project.id, cells: withdrawn,
        lane: activeLane, source: "ui", surface: "selection",
      })
      setRunning({ kind: "idle" })
    }
  }, [audioRemoveTargets, isBusy, project, username, commitAudioValidation, t, activeLane])

  const onTranslate = useCallback(async () => {
    if (isBusy) return
    // AQU-1459: never call the model for someone whose commit is already denied.
    if (!canCommitTarget) return
    setRunning({ kind: "translate" })
    try {
      const missing = selectedCells.filter(
        (c) => !c.translated.trim() && c.original?.trim(),
      )
      if (missing.length > 0 && completeBatch) {
        await completeBatch(missing)
      }
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, completeBatch, isBusy, canCommitTarget])

  const onVoice = useCallback(async () => {
    if (isBusy || !onVoiceTogether) return
    setRunning({ kind: "voice" })
    try {
      await onVoiceTogether(selectedCells.filter((c) => c.type !== "paratext" && c.translated.trim()))
    } catch (err) {
      // A failed "Voice together" used to end here as an unhandled rejection
      // with nothing on screen. The rows keep their own error badge with "Try
      // again" (combined-voice.ts sets it); the toast is the one message for
      // the whole run, and the only one for a failure before any row was
      // touched (signed out, too few lines, lines too long).
      const reason = categorizeAiError(err instanceof Error ? err.message : String(err))
      // The engine bodies are written for ONE line's badge ("This line uses
      // Inworld TTS…"); this notice is about several, so those four speak of
      // "these lines" instead (walk 10-02).
      const engineBody = VOICE_TOGETHER_ENGINE_BODY[reason.category]
      toast.add({
        type: "error",
        title: t("editor.selection.voiceTogetherFailed"),
        // A toast has no "technical detail" disclosure to point at, so the
        // two generic bodies that send the reader there give way to their
        // heading; the line's badge still carries the raw text.
        description: engineBody
          ? t(engineBody)
          : /technical detail below/i.test(reason.body) ? reason.title : reason.body,
      })
      // Catching it removes the automatic `$exception` that was the only
      // trace of this failure, so report it by hand.
      posthog.captureException(err instanceof Error ? err : new Error(String(err)), {
        surface: "voice-together",
        project_id: project.id,
      })
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, onVoiceTogether, isBusy, t, project.id])

  const onValidate = useCallback(() => {
    if (isBusy) return
    setRunning({ kind: "validate" })
    try {
      // AQU-1503: the eligibility split, the toast wording and the telemetry
      // now come from the same summary the "Batch validate text…" workspace
      // action uses, so the two surfaces can no longer disagree about what a
      // batch did — and neither can end in silence. The old loop reported only
      // one class of skip ("already validated"); an AI draft, an out-of-scope
      // cell or an unsaved edit fell out of the count with nothing said.
      const summary = summarizeBatchValidate(selectedCells, {
        username,
        myScopes,
        activeLane,
        hasTarget: Boolean(project.id),
        canValidate: textScopeCanValidate,
        noPermissionReason,
        allowAiDrafts: allowBulkValidateAiDrafts,
        allowSelfValidation,
      })
      const queued = summary.validatable.map((cell) =>
        emitCellValidate({
          projectId: project.id,
          fileId: cell.fileId,
          cellId: cell.id,
          author: username,
          editEventId: cell.targetEventId!,
          targetLang: activeLane, // AQU-633: '' omitted on the wire by the emit
        }).then(() => ({ fileId: cell.fileId, cellId: cell.id })),
      )
      posthog.capture(BATCH_VALIDATE_ATTEMPTED, batchValidateTelemetry(summary, "selection"))
      // AQU-1572: counted once every write has reached the outbox (or failed
      // to), so a write that never landed is not reported as a validation.
      void reportQueued(queued, (cells) => reportValidation({
        medium: "text", validated: true, projectId: project.id, cells,
        lane: activeLane, source: "ui", surface: "selection",
      }))
      const message = batchValidateToast(summary, t, formatLocaleList)
      toast.add({
        type: message.type,
        title: message.title,
        ...(message.description ? { description: message.description } : {}),
      })
      // AQU-616: flush the just-enqueued validates now instead of waiting for
      // the ~5s periodic flusher, so the confirmed/synced state lands promptly.
      if (summary.validatable.length > 0) onValidationCommitted?.()
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, username, activeLane, myScopes, isBusy, project.id, onValidationCommitted, t, formatLocaleList, allowBulkValidateAiDrafts, allowSelfValidation, textScopeCanValidate, noPermissionReason])

  const onUnvalidate = useCallback(() => {
    if (isBusy) return
    if (unvalidatableCount === 0) return
    setRunning({ kind: "validate" })
    try {
      const removed: Array<Promise<{ fileId: string; cellId: string }>> = []
      for (const cell of selectedCells) {
        if (!cell.translated.trim()) continue
        if (!cell.activeValidators.includes(username)) continue
        if (!isInMemberScope(myScopes, cell.fileId, activeLane)) continue // AQU-633: skip out-of-scope
        if (!cell.targetEventId || !project.id) continue
        removed.push(emitCellUnvalidate({
          projectId: project.id,
          fileId: cell.fileId,
          cellId: cell.id,
          author: username,
          editEventId: cell.targetEventId,
          targetLang: activeLane, // AQU-633: '' omitted on the wire by the emit
        }).then(() => ({ fileId: cell.fileId, cellId: cell.id })))
      }
      toast.add({
        type: "success",
        title: t("editor.selection.unvalidatedToast", { count: removed.length }),
      })
      void reportQueued(removed, (cells) => reportValidation({
        medium: "text", validated: false, projectId: project.id, cells,
        lane: activeLane, source: "ui", surface: "selection",
      }))
      // AQU-616: flush now rather than waiting for the periodic flusher.
      if (removed.length > 0) onValidationCommitted?.()
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, username, activeLane, myScopes, unvalidatableCount, isBusy, project.id, onValidationCommitted, t])

  // AQU-365: viewers (and any role below the lowest gated action here —
  // REVIEWER 300, the validate floor) get no selection affordance at all.
  // canPerform fails OPEN when the role is unknown (local/legacy projects
  // with no syncRole), so this only suppresses the bar for a KNOWN
  // sub-reviewer role — never blocks legacy non-cloud projects.
  if (roleLevel != null && !canPerform("cell.validate", roleLevel) && !canCommitTarget) {
    return null
  }

  if (selectedCells.length === 0) return null

  return (
    <div
      className={cn(
        "pointer-events-auto fixed left-1/2 z-30 flex -translate-x-1/2 items-center gap-2",
        "bottom-4 rounded-md border bg-card px-4 py-2 text-xs ring-1 ring-foreground/10",
      )}
      role="toolbar"
      aria-label={t("editor.selection.actions")}
    >
      {/* Never wraps: with two validation pairs beside it the label was the
          only flexible thing left and folded onto four lines. It keeps its
          width; the buttons take the squeeze (Sam, 2026-09-22). */}
      <span className="shrink-0 whitespace-nowrap font-medium">
        {t("editor.selection.count", { count: selectedCells.length })}
        {missingCount > 0 && (
          <span className="ms-1 text-muted-foreground">
            {t("editor.selection.needTranslation", { count: missingCount })}
          </span>
        )}
      </span>
      <div className="mx-1 h-5 w-px rounded-lg" />
      {audioMode && (
        <AppTooltip content={
          !onVoiceTogether ? t("editor.selection.voiceUnavailable") :
          voiceableCount < 2 ? t("editor.selection.voiceNeedTwo") :
          t("editor.selection.voiceTooltip", { count: voiceableCount })
        }>
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={onVoice}
            disabled={isBusy || voiceableCount < 2 || !onVoiceTogether}
          >
            {running.kind === "voice" ? (
              <Spinner className="me-1 size-3.5" />
            ) : (
              <Sparkles className="me-1 h-3.5 w-3.5" />
            )}
            {t("editor.selection.voiceTogether")}
            {voiceableCount > 1 && (
              <span className="ms-1 rounded-md bg-primary-foreground/20 px-1.5 py-0.5 tabular-nums text-primary-foreground">
                {Math.min(voiceableCount, 12)}
              </span>
            )}
          </Button>
        </AppTooltip>
      )}
      {!audioMode && (
        <>
      <AppTooltip content={
        // AQU-1459: the permission reason comes FIRST. A validator sees why the
        // button is dark in the terms of their role, not "all translated".
        !canCommitTarget ? t("editor.selection.translateNoPermission") :
        !completeBatch ? t("editor.selection.translateNotConfigured") :
        missingCount === 0 ? t("editor.selection.allTranslated") :
        t("editor.selection.translateTooltip", { count: missingCount })
      }>
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={onTranslate}
          disabled={isBusy || missingCount === 0 || !completeBatch || !canCommitTarget}
        >
          {running.kind === "translate" ? (
            <Spinner className="me-1 size-3.5" />
          ) : (
            <Languages className="me-1 h-3.5 w-3.5" />
          )}
          {t("editor.selection.translate")}
          {missingCount > 0 && allHaveTranslation === false && (
            <span className="ms-1 rounded-md bg-primary-foreground/20 px-1.5 py-0.5 tabular-nums text-primary-foreground">
              {missingCount}
            </span>
          )}
        </Button>
      </AppTooltip>
      <AppTooltip content={
        validateDisabledReason
          ?? validatePartialTooltip
          ?? t("editor.selection.validateTooltip", { count: validatableCount })
      }>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onValidate}
          disabled={isBusy || validatableCount === 0}
        >
          {running.kind === "validate" ? (
            <Spinner className="me-1 size-3.5" />
          ) : null}
          {t("editor.selection.validateText")}
          {validatableCount > 0 && (
            <span className="ms-1 rounded-md bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">
              {validatableCount}
            </span>
          )}
        </Button>
      </AppTooltip>
      <AppTooltip content={
        unvalidatableCount === 0
          ? t("editor.selection.noValidations")
          : t("editor.selection.unvalidateTooltip", { count: unvalidatableCount })
      }>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onUnvalidate}
          disabled={isBusy || unvalidatableCount === 0}
        >
          {t("editor.selection.removeMyValidations")}
          {unvalidatableCount > 0 && (
            <span className="ms-1 rounded-md bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">
              {unvalidatableCount}
            </span>
          )}
        </Button>
      </AppTooltip>
        </>
      )}
      {/* AQU-490 — the audio pair, and it is a PAIR: "Validate audio" used to
          be a lone button that vanished the moment you used it, so the click
          that emptied it also hid the way back. Sam, 2026-09-22: it behaves
          like the text pair beside it, always present and merely enabled or
          disabled, with an opposite action.

          Present once the FILE has audio rather than once the SELECTION has
          something to validate — that difference is the fix. A text-only file
          still shows only the text pair, so nothing grows two dead buttons.

          OUTSIDE the `!audioMode` branch, unlike the text actions: the Audio
          view is where recordings are worked on, and this is the one
          validation it offers. */}
      {fileHasAudio && (
        <>
          <AppTooltip content={
            validateAudioDisabledReason
              ? validateAudioDisabledReason
              : t("editor.selection.validateAudioTooltip", { count: audioTakeTargets.length })
          }>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onValidateAudio}
              disabled={isBusy || audioTakeTargets.length === 0}
            >
              {running.kind === "validate-audio" ? <Spinner className="me-1 size-3.5" /> : null}
              {t("editor.selection.validateAudio")}
              {audioTakeTargets.length > 0 && (
                <span className="ms-1 rounded-md bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">
                  {audioTakeTargets.length}
                </span>
              )}
            </Button>
          </AppTooltip>
          <AppTooltip content={
            audioRemoveTargets.length === 0
              ? t("editor.selection.noAudioValidations")
              : t("editor.selection.unvalidateAudioTooltip", { count: audioRemoveTargets.length })
          }>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onUnvalidateAudio}
              disabled={isBusy || audioRemoveTargets.length === 0}
            >
              {t("editor.selection.removeMyAudioValidations")}
              {audioRemoveTargets.length > 0 && (
                <span className="ms-1 rounded-md bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">
                  {audioRemoveTargets.length}
                </span>
              )}
            </Button>
          </AppTooltip>
        </>
      )}
      {!audioMode && (
        <>
      {/* AQU-186: Harmonize affordance — appears when ≥ 1 selected cell has a
          translation (v1 minimum per spec). Disabled when canHarmonize=false
          (role too low) or onHarmonize callback not provided. */}
      {onHarmonize != null && harmonizableCount > 0 && (
        <AppTooltip content={
          !canHarmonize
            ? t("editor.selection.harmonizeNeedLead")
            : t("editor.selection.harmonizeTooltip", { count: harmonizableCount })
        }>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onHarmonize(selectedCells.filter((c) => c.translated.trim()))}
            disabled={isBusy || !canHarmonize}
            data-testid="selection-harmonize-btn"
          >
            <Wand2 className="me-1 h-3.5 w-3.5" />
            {t("editor.selection.harmonize")}
            <span className="ms-1 rounded-md bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">
              {harmonizableCount}
            </span>
          </Button>
        </AppTooltip>
      )}
        </>
      )}
      <AppTooltip content={t("editor.selection.clearTooltip")}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => clearSelection()}
          disabled={isBusy}
          aria-label={t("editor.selection.clear")}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
    </div>
  )
}
