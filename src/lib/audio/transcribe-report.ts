// AQU-2375: what the end of a transcription run says, from its per-row report.
//
// One place for every run's last word (the post-import run, Transcribe all,
// the sections someone selected, and a run carried on after a reload), so the
// rule holds everywhere: a run where some rows failed never ends on a flat
// "Transcribed N". It says how many landed, how many did not and why, and
// offers to retry just those.
//
// Sam, Nov 12: this is the ONE closing message, Transcribe all's from the file
// menu too (AQU-2521). Its reasons are every reason a run knows: the rows that
// failed, and the rows that had nothing to transcribe where the run counts
// them (`TranscribeRunReport.heardNothing`).

import { t } from "@/lib/i18n/standalone"
import type { TranscribeRunReport } from "./batch-audio"
import type { TranscribeRunKind } from "./transcribe-runs"
import type { LineWordsReport } from "./line-words-run"
import type { CellData } from "@/hooks/useCells"

export interface TranscribeRunToast {
  type: "success" | "error" | "info"
  title: string
  description?: string
  /** Set when some rows failed: the label of a button that retries them. */
  retryLabel?: string
}

/**
 * The toast for a finished run, or null when nothing ran. `fileName` names the
 * recording for a run over one recording's sections (the post-import run);
 * other runs count recordings. `quiet` (the selected sections, which never
 * had a toast) speaks only when a row failed (the review, Nov 12).
 */
export function transcribeRunToast(
  report: TranscribeRunReport,
  opts: { kind: TranscribeRunKind; fileName?: string; quiet?: boolean },
): TranscribeRunToast | null {
  if (!report.started || report.total === 0) return null
  if (opts.quiet && report.failed.length === 0) return null
  const sections = opts.kind === "import" && opts.fileName !== undefined
  const name = opts.fileName ?? ""
  const failed = report.failed.length
  const firstReason = report.failed[0]?.message ?? ""
  const retryLabel = failed > 0 ? t("audio.transcribeRun.retry", { count: failed }) : undefined
  // Sam, Nov 12: one closing message for every run, with every reason the run
  // knows. A row that heard nothing (`heardNothing`, where the run counts it)
  // had no words to keep, so it is not counted as transcribed: it is a reason.
  const heardNothing = Math.min(report.heardNothing ?? 0, report.transcribed)
  const done = report.transcribed - heardNothing
  const reasons = [
    heardNothing > 0 ? t("audio.transcribeRun.heardNothing", { count: heardNothing }) : null,
    failed > 0 ? t("audio.transcribeRun.failedSome", { count: failed, reason: firstReason }) : null,
  ].filter(Boolean).join(" ")

  if (report.cancelled) {
    return {
      type: "info",
      title: t("audio.transcribeRun.stopped", { done, count: report.total }),
      ...(reasons ? { description: reasons } : {}),
      ...(retryLabel ? { retryLabel } : {}),
    }
  }
  if (failed === 0 && done >= report.total) {
    return {
      type: "success",
      title: sections
        ? t("audio.transcribeRun.doneSections", { count: report.total, name })
        : t("audio.transcribeRun.doneRecordings", { count: report.total }),
    }
  }
  if (report.transcribed === 0 && failed > 0) {
    return {
      type: "error",
      title: sections
        ? t("audio.transcribeRun.failedAllNamed", { name, reason: firstReason })
        : t("audio.transcribeRun.failedAll", { reason: firstReason }),
      ...(retryLabel ? { retryLabel } : {}),
    }
  }
  // Some landed and some did not, or some were never reached (a row with no
  // recording any more), or some had nothing to transcribe: never a flat
  // success.
  return {
    type: failed > 0 ? "error" : "info",
    title: sections
      ? t("audio.transcribeRun.partialSections", { done, count: report.total, name })
      : t("audio.transcribeRun.partialRecordings", { done, count: report.total }),
    ...(reasons ? { description: reasons } : {}),
    ...(retryLabel ? { retryLabel } : {}),
  }
}

/** What the end of a run shows, in the app's toast's terms. */
export interface TranscribeRunEndContent {
  type: TranscribeRunToast["type"]
  title: string
  /** Always given, undefined to clear what the progress toast said (the
   *  hosted limit's wait). */
  description: string | undefined
  actionProps: { children: string; onClick: () => void } | undefined
}

/** The toast functions the end of a run uses: the app's `toast`. */
export interface TranscribeRunEndToasts {
  add(content: TranscribeRunEndContent): unknown
  update(id: string, content: TranscribeRunEndContent): void
  close(id: string): void
}

/**
 * AQU-2375: a run's last word (`transcribeRunToast`), said in the run's
 * progress toast when it has one, with a Retry for the rows that failed (a
 * row that failed before a reload has only its id, and is left out of it).
 * With nothing to say, a quiet run that went well, its progress toast is
 * closed (the check of the q44 fixes, Nov 12: a run carried on after a reload
 * has one, and it was left spinning for good).
 */
export function endTranscribeRunToast(
  report: TranscribeRunReport,
  opts: { kind: TranscribeRunKind; fileName?: string; quiet?: boolean; progressToastId: string | null },
  toasts: TranscribeRunEndToasts,
  retry: (cells: CellData[]) => void,
): void {
  const said = transcribeRunToast(report, {
    kind: opts.kind,
    ...(opts.fileName !== undefined ? { fileName: opts.fileName } : {}),
    ...(opts.quiet ? { quiet: true } : {}),
  })
  if (!said) {
    if (opts.progressToastId !== null) toasts.close(opts.progressToastId)
    return
  }
  const retryCells = report.failed.flatMap((f) => (f.cell ? [f.cell] : []))
  const content: TranscribeRunEndContent = {
    type: said.type,
    title: said.title,
    description: said.description,
    actionProps: said.retryLabel && retryCells.length > 0
      ? { children: said.retryLabel, onClick: () => retry(retryCells) }
      : undefined,
  }
  if (opts.progressToastId !== null) toasts.update(opts.progressToastId, content)
  else toasts.add(content)
}

/** The progress toast's title while a run goes on. */
export function transcribeRunProgressTitle(opts: {
  kind: TranscribeRunKind
  fileName?: string
  done: number
  total: number
  /** The run is one a page reload stopped, picked back up. Said on its first call. */
  carriedOn?: boolean
  first: boolean
}): string {
  const name = opts.fileName ?? ""
  if (opts.first && opts.carriedOn) {
    return t("audio.transcribeRun.carryingOn", { name, done: opts.done, count: opts.total })
  }
  if (opts.first && opts.done === 0) {
    return opts.kind === "import" && opts.fileName !== undefined
      ? t("audio.transcribeRun.progressSections", { count: opts.total, name })
      : t("audio.transcribeRun.progressRecordings", { count: opts.total })
  }
  return t("audio.transcribeRun.progressCount", { done: opts.done, count: opts.total })
}

/**
 * AQU-2426 × AQU-2375: what a line's words run says when it ends without words
 * for every minute, or null when it has them all (the caller splits). The line
 * is never split then: it stays whole, keeps the words it has, and Retry sends
 * only the minutes still missing.
 */
export function lineWordsToast(report: LineWordsReport, name: string): TranscribeRunToast | null {
  if (report.done >= report.total) return null
  // AQU-2426 / AQU-2375 (review, Nov 9): stopped with its Cancel. Nothing
  // failed, and nothing was written to the line: the words so far wait in the
  // kept run for whoever transcribes the rest.
  if (report.cancelled) {
    return {
      type: "info",
      title: t("audio.lineWords.stopped", { done: report.done, count: report.total, name }),
      description: t("audio.lineWords.stoppedKept"),
      retryLabel: t("audio.lineWords.transcribeRest"),
    }
  }
  const missing = report.total - report.done
  const reason = report.failed[0]?.message ?? ""
  const retryLabel = t("audio.transcribeRun.retry", { count: missing })
  if (report.done === 0) {
    return { type: "error", title: t("editor.splitLines.importFailed", { name, reason }), retryLabel }
  }
  return {
    type: "error",
    title: t("audio.lineWords.partial", { done: report.done, count: report.total, name }),
    description: `${t("audio.transcribeRun.failedSome", { count: missing, reason })} ${t("audio.lineWords.staysWhole")}`,
    retryLabel,
  }
}
