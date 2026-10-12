// AQU-1722: selection-driven batch voice generation.
//
// "Generate voice" on the selection bar: the reader multi-selects lines, picks
// one voice, and every selected line is spoken in it. That is the SELECTION-
// driven half of batch audio; AQU-1109 owns the VOICE-driven half (apply a
// voice to the takes that already exist). Both run on the one queue in
// `batch-audio.ts` (`runBatchJobs`) — there is deliberately no second queue,
// no second progress store and no second Cancel button.
//
// The whole module is split into a PLAN and a RUN for one reason: everything
// the reader needs to be told before committing credits — how many lines will
// actually be spoken, which are skipped and why, how many words that is and
// what it costs — has to be computable WITHOUT generating anything. The dialog
// renders the plan; the run executes exactly the plan it was shown.
//
// What it refuses to do silently:
//   - overwrite a line that already has a generated take (AQU-965's lesson:
//     the choice is explicit, and "overwrite" still attaches a NEW take rather
//     than destroying the old one — selection moves, history keeps);
//   - report a failure as a bare "audio failed" (AQU-344's lesson: every
//     failure carries the line it belongs to and an actionable reason);
//   - run past the word allowance and halt mid-batch with nothing said.

import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { countWords, wordsToCredits, WORDS_PER_CREDIT_DEFAULT } from "@/lib/billing/plans"
import { categorizeAiError, type ErrorCategory } from "./ai-error"
import { getTtsStatus, ttsStatusKey } from "./tts"
import { generateCellVoice } from "./voice-generate-helpers"
import {
  isBatchSynthCancelled,
  resetBatchSynthCancel,
  runBatchJobs,
} from "./batch-audio"

/** What to do with a selected line that already carries a generated take. */
export type BatchVoiceExisting = "skip" | "overwrite"

/**
 * Why a selected line is not going to be spoken. Every one of these is
 * REPORTED rather than dropped — a batch that quietly does 6 of 10 lines is
 * the failure mode this ticket exists to prevent.
 */
export type BatchVoiceSkipReason =
  /** Not translatable content (a heading, a note) — nothing to say. */
  | "paratext"
  /** No committed target text yet. */
  | "no-text"
  /** Already has a generated take and the reader chose `skip`. */
  | "has-audio"
  /** A generation for this line is already running (per-cell button, or an
   *  earlier batch still finishing). Never queued twice. */
  | "in-flight"
  /** Would run past the org's remaining word allowance. */
  | "over-allowance"
  /** The reader declined the on-device model download. A choice, not a fault. */
  | "declined"

export interface BatchVoiceTarget {
  cell: CellData
  /** The words that will be spoken. */
  text: string
  /** `countWords(text)` — what the allowance is metered in. */
  words: number
}

export interface BatchVoiceSkip {
  cellId: string
  reason: BatchVoiceSkipReason
}

/** The org's remaining metered allowance, as `OrgBilling` reports it. */
export interface BatchVoiceAllowance {
  /** Words left this period. `null` = unmetered (no allowance configured). */
  remainingWords: number | null
  /** Words per credit for the display estimate; defaults to the plan default. */
  wordsPerCredit?: number
}

export interface BatchVoicePlan {
  /** Lines that will be spoken, in the order they were given. */
  targets: BatchVoiceTarget[]
  /** Lines that will not be, each with its reason. */
  skipped: BatchVoiceSkip[]
  /** Words across `targets` — the pre-estimate's basis. */
  words: number
  /** `words` expressed in credits, for the dialog's "≈ N cr". */
  credits: number
  /** How many lines were dropped purely because the allowance ran out. */
  overAllowance: number
  /** Allowance left before the run, `null` when unmetered. */
  remainingWords: number | null
  /** The allowance is already spent, so not one line can run. */
  exhausted: boolean
}

export interface PlanBatchVoiceArgs {
  /** The selected lines, in document order. */
  cells: readonly CellData[]
  existing: BatchVoiceExisting
  /** Omitted ⇒ unmetered: no pre-estimate gate, estimate still shown. */
  allowance?: BatchVoiceAllowance
  /** Defaults to the per-cell tts status store. */
  isInFlight?: (cellId: string) => boolean
}

/** Does this line already carry a generated voice take? */
export function hasGeneratedVoice(cell: CellData): boolean {
  return Boolean(cell.selectedGeneratedVoiceAudioId)
}

function defaultIsInFlight(cellId: string): boolean {
  const st = getTtsStatus(ttsStatusKey(cellId))
  return st.kind === "loading" || st.kind === "synthesizing"
}

/**
 * Work out exactly what a batch would do, without doing any of it.
 *
 * The allowance pass is deliberately a PREFIX: lines are taken in order until
 * one does not fit, and that line and every line after it are reported as
 * `over-allowance`. Packing the tail with whichever short lines happened to
 * fit would make the run's scope depend on line lengths in a way nobody can
 * predict from the screen — "it stopped at line 14" is explicable, "it did 3,
 * 7 and 9" is not.
 */
export function planBatchVoice(args: PlanBatchVoiceArgs): BatchVoicePlan {
  const { cells, existing } = args
  const isInFlight = args.isInFlight ?? defaultIsInFlight
  const wordsPerCredit = args.allowance?.wordsPerCredit ?? WORDS_PER_CREDIT_DEFAULT
  const remainingWords = args.allowance?.remainingWords ?? null

  const skipped: BatchVoiceSkip[] = []
  const eligible: BatchVoiceTarget[] = []

  for (const cell of cells) {
    if (cell.type === "paratext") {
      skipped.push({ cellId: cell.id, reason: "paratext" })
      continue
    }
    const text = cell.translated?.trim() ?? ""
    if (!text) {
      skipped.push({ cellId: cell.id, reason: "no-text" })
      continue
    }
    if (existing === "skip" && hasGeneratedVoice(cell)) {
      skipped.push({ cellId: cell.id, reason: "has-audio" })
      continue
    }
    if (isInFlight(cell.id)) {
      skipped.push({ cellId: cell.id, reason: "in-flight" })
      continue
    }
    eligible.push({ cell, text, words: countWords(text) })
  }

  const targets: BatchVoiceTarget[] = []
  let words = 0
  let capped = false
  for (const t of eligible) {
    if (!capped && remainingWords != null && words + t.words > remainingWords) capped = true
    if (capped) {
      skipped.push({ cellId: t.cell.id, reason: "over-allowance" })
      continue
    }
    targets.push(t)
    words += t.words
  }

  const overAllowance = skipped.filter((s) => s.reason === "over-allowance").length
  return {
    targets,
    skipped,
    words,
    credits: wordsToCredits(words, wordsPerCredit),
    overAllowance,
    remainingWords,
    // Nothing at all can run because of the allowance — distinct from a batch
    // that simply had no eligible lines, and it needs different advice.
    exhausted: targets.length === 0 && overAllowance > 0,
  }
}

export interface BatchVoiceFailure {
  cellId: string
  /** Actionable heading from `categorizeAiError` — never "audio failed". */
  title: string
  /** The explanatory body for that category. */
  message: string
  category: ErrorCategory
}

export interface BatchVoiceRunResult {
  /** Lines that got a take. */
  generated: number
  /** Lines that were attempted and failed, each with its reason. */
  failures: BatchVoiceFailure[]
  /** The plan's skips, plus any line that declined mid-run. */
  skipped: BatchVoiceSkip[]
  /** Planned lines the run never reached (cancelled, or stopped at the cap). */
  notAttempted: string[]
  cancelled: boolean
  /** The provider's own quota stopped the run — see `stopReason`. */
  stoppedAtCap: boolean
}

export interface RunBatchVoiceArgs {
  plan: BatchVoicePlan
  project: ProjectRecord
  session: FrontierSession | null
  username: string
  /** The one voice every line in this batch speaks in. */
  voiceId: string
  /** AQU-1462: the lane being worked in. Omitted for the default lane. */
  targetLang?: string
}

/**
 * Speak every line in the plan, in the chosen voice.
 *
 * Takes attach through `generateCellVoice` — the same path the per-cell button
 * uses — so the events, the integer-ms duration guard (AQU-927) and the
 * durability of the result are identical to a single-cell generation. This
 * module adds no attach path of its own; that is the point.
 *
 * A failure never aborts the run: it is recorded against its line and the
 * queue moves on. The ONE exception is the provider's daily quota, which
 * cannot resolve itself before the next line — carrying on would turn one
 * clear "you are out of budget" into N identical failures. That stops the run
 * and says so, which is the clean stop the ticket asks for.
 */
export async function runBatchVoice(args: RunBatchVoiceArgs): Promise<BatchVoiceRunResult> {
  const { plan, project, session, username, voiceId } = args
  const result: BatchVoiceRunResult = {
    generated: 0,
    failures: [],
    skipped: [...plan.skipped],
    notAttempted: [],
    cancelled: false,
    stoppedAtCap: false,
  }
  if (plan.targets.length === 0) return result

  const attempted = new Set<string>()
  resetBatchSynthCancel()

  await runBatchJobs(
    plan.targets,
    async (t) => {
      attempted.add(t.cell.id)
      const ok = await generateCellVoice({
        project,
        cell: t.cell,
        session,
        username,
        voiceId,
        text: t.text,
        ...(args.targetLang ? { targetLang: args.targetLang } : {}),
        surface: "selection",
      })
      if (ok) {
        result.generated++
        return
      }
      // `generateCellVoice` surfaces the reason on the per-cell badge rather
      // than throwing, so the badge IS the error channel — read it back and
      // give the line's failure a name the reader can act on.
      const st = getTtsStatus(ttsStatusKey(t.cell.id))
      if (st.kind !== "error") {
        // Idle after a false return is the consent-denied path: a declined
        // model download, which must never be painted as a fault.
        result.skipped.push({ cellId: t.cell.id, reason: "declined" })
        return
      }
      const actionable = categorizeAiError(st.message)
      result.failures.push({
        cellId: t.cell.id,
        title: actionable.title,
        message: actionable.body,
        category: actionable.category,
      })
      if (actionable.category === "daily-quota-exceeded") result.stoppedAtCap = true
    },
    {
      kind: "synth",
      isCancelled: () => isBatchSynthCancelled() || result.stoppedAtCap,
      onItemDone: () => { /* the per-cell badge carries its own state */ },
    },
  )

  result.cancelled = isBatchSynthCancelled()
  result.notAttempted = plan.targets.filter((t) => !attempted.has(t.cell.id)).map((t) => t.cell.id)
  return result
}
