// AQU-2375: what the end of a transcription run says, from its per-row report.
//
// One place for every run's last word (the post-import run, Transcribe all,
// the sections someone selected, and a run carried on after a reload), so the
// rule holds everywhere: a run where some rows failed never ends on a flat
// "Transcribed N". It says how many landed, how many did not and why, and
// offers to retry just those.

import { t } from "@/lib/i18n/standalone"
import type { TranscribeRunReport } from "./batch-audio"
import type { TranscribeRunKind } from "./transcribe-runs"

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
 * other runs count recordings.
 */
export function transcribeRunToast(
  report: TranscribeRunReport,
  opts: { kind: TranscribeRunKind; fileName?: string },
): TranscribeRunToast | null {
  if (!report.started || report.total === 0) return null
  const sections = opts.kind === "import" && opts.fileName !== undefined
  const name = opts.fileName ?? ""
  const failed = report.failed.length
  const firstReason = report.failed[0]?.message ?? ""
  const failedLine = failed > 0 ? t("audio.transcribeRun.failedSome", { count: failed, reason: firstReason }) : undefined
  const retryLabel = failed > 0 ? t("audio.transcribeRun.retry", { count: failed }) : undefined

  if (report.cancelled) {
    return {
      type: "info",
      title: t("audio.transcribeRun.stopped", { done: report.transcribed, count: report.total }),
      ...(failedLine ? { description: failedLine } : {}),
      ...(retryLabel ? { retryLabel } : {}),
    }
  }
  if (failed === 0 && report.transcribed >= report.total) {
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
  // recording any more): never a flat success.
  return {
    type: failed > 0 ? "error" : "info",
    title: sections
      ? t("audio.transcribeRun.partialSections", { done: report.transcribed, count: report.total, name })
      : t("audio.transcribeRun.partialRecordings", { done: report.transcribed, count: report.total }),
    ...(failedLine ? { description: failedLine } : {}),
    ...(retryLabel ? { retryLabel } : {}),
  }
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
