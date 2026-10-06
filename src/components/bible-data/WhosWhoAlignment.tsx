// Who's Who panel (AQU-1694): the word alignment behind highlights on a
// gateway-language source.
//
// AQU-1689 left a note here ("word highlights need an alignment"). It is now
// the place where a maintainer aligns the open book's source text to the
// Greek (Bridge 1), sees it run (cancellable), and later sees how much of the
// book is aligned, which verses changed since, and what dotted highlights
// mean. Anyone else reads the same status, and the note says who can align.
// Hidden for a Greek or Hebrew source, whose words are the pack's own.

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { SOLID_MIN_PAIRS } from "@/lib/bible-data/bridge-compose"
import type { BkpTextLayer } from "@/lib/bible-data/pack-types"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"
import {
  cancelSourceAlignment,
  ensureSourceAlignment,
  startSourceAlignment,
  useSourceAlignment,
  type AlignmentFailure,
  type AlignmentRun,
} from "./source-alignment-store"

const FAILURE_KEYS: Readonly<Record<AlignmentFailure, MessageKey>> = {
  offline: "bibleAlignment.failed.offline",
  forbidden: "bibleAlignment.failed.forbidden",
  failed: "bibleAlignment.failed.failed",
}

interface WhosWhoAlignmentProps {
  projectId: string
  fileId: string
  /** The pack's text layer for the file's book; null while it loads. */
  text: BkpTextLayer | null
  /** The person may run the alignment (Maintainer and up). */
  canAlign: boolean
  getTokenForFile: (fileId: string) => Promise<string | null>
}

function runFraction(run: AlignmentRun): number | null {
  if (run.phase === "aligning" || run.phase === "saving") return run.total > 0 ? run.done / run.total : 0
  return null
}

export function WhosWhoAlignment({ projectId, fileId, text, canAlign, getTokenForFile }: WhosWhoAlignmentProps) {
  const t = useT()
  const fmt = useFormat()
  const { status, run } = useSourceAlignment(projectId, fileId)

  useEffect(() => {
    ensureSourceAlignment(projectId, fileId, getTokenForFile)
  }, [projectId, fileId, getTokenForFile])

  const start = () => {
    if (text) startSourceAlignment({ projectId, fileId, text, tokenFor: getTokenForFile })
  }
  const running = run !== null && run.phase !== "failed"

  if (running) {
    const fraction = runFraction(run)
    const percent = fmt.isolate(fmt.percent(fraction ?? 0))
    const label =
      run.phase === "reading"
        ? t("bibleAlignment.phase.reading")
        : t(run.phase === "aligning" ? "bibleAlignment.phase.aligning" : "bibleAlignment.phase.saving", { percent })
    return (
      <div data-testid="whos-who-alignment" className="flex flex-col gap-2 border-t px-3 py-2 text-xs">
        <p role="status" className="text-muted-foreground">
          {label}
        </p>
        <Progress value={fraction === null ? null : Math.round(fraction * 100)} aria-label={t("bibleAlignment.progressAria")} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => cancelSourceAlignment(projectId, fileId)}
        >
          {t("bibleAlignment.cancel")}
        </Button>
      </div>
    )
  }

  const ready = status.kind === "ready" ? status : null
  const aligned = ready ? ready.cells.size : 0
  const stale = ready ? ready.staleCells : 0
  const hasAlignment = aligned > 0 || stale > 0
  const short = ready?.trainedPairs !== null && ready?.trainedPairs !== undefined && ready.trainedPairs < SOLID_MIN_PAIRS

  return (
    <div data-testid="whos-who-alignment" className="flex flex-col gap-1.5 border-t px-3 py-2 text-xs text-muted-foreground">
      {hasAlignment ? (
        <>
          <p data-testid="whos-who-alignment-status">{t("bibleAlignment.aligned", { count: aligned })}</p>
          {stale > 0 && <p data-testid="whos-who-alignment-stale">{t("bibleAlignment.stale", { count: stale })}</p>}
          <p>
            {short
              ? t("bibleAlignment.shortBook", { min: fmt.number(SOLID_MIN_PAIRS) })
              : t("bibleAlignment.dotted")}
          </p>
        </>
      ) : (
        <p data-testid="whos-who-alignment-note">
          {canAlign ? t("bibleAlignment.intro") : t("bibleData.whosWho.panel.alignmentNote")}
        </p>
      )}
      {run?.phase === "failed" && (
        <p role="alert" className="text-destructive">
          {t(FAILURE_KEYS[run.reason])}
        </p>
      )}
      {canAlign ? (
        <Button
          type="button"
          variant={hasAlignment ? "outline" : "default"}
          size="sm"
          className="mt-1 self-start"
          disabled={!text}
          onClick={start}
        >
          {run?.phase === "failed"
            ? t("bibleAlignment.retry")
            : hasAlignment
              ? t("bibleAlignment.alignAgain")
              : t("bibleAlignment.align")}
        </Button>
      ) : (
        !hasAlignment && <p>{t("bibleAlignment.askMaintainer")}</p>
      )}
    </div>
  )
}
