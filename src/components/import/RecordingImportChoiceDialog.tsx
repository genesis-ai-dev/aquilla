// AQU-2426: the import's last step for a recording with no subtitle file
// (board 58, part 1). Sam, Nov 3 and 5: nothing brought in is cut into lines or
// transcribed on its own; the person chooses.
//
//   • Two choices side by side, both plain (outline), with Cancel quieter
//     (ghost) — so neither looks like the default and Enter does nothing until
//     one is picked.
//   • Import: the whole recording, one Source audio line each (plus the film);
//     the note above the buttons says "whole", so the button is just the verb.
//   • Import and transcribe…: a second step shows what it will cost — minutes,
//     requests, roughly how long, the model, and credits — before anything
//     runs. Back (the arrow) returns to the choice.
//   • Someone who may not transcribe sees it greyed, with an (i) that opens
//     the reason in place under the buttons, on a click (never a hover).
//   • Several files ask once, with their total length.

import { useId, useState } from "react"
import { ArrowLeft, FileAudio, FileVideo, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { fmtCueClock } from "@/components/timeline/format"
import { captionFileLimitLabel } from "@/lib/import/caption-file-limit"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { roleNameKey } from "@/lib/frontier/roles"
import type { TranscribeBlock } from "@/lib/audio/transcribe-access"
import type { TranscriptionCost } from "@/lib/audio/transcription-cost"
import { audioLength, TranscriptionCostLines } from "./TranscriptionCostLines"

export interface RecordingChoiceFile {
  name: string
  sizeBytes: number
  durationMs?: number
  isVideo: boolean
  /** AQU-2344 (review, Nov 9): an .mp4 or .m4a too big to be read for captions
   *  inside it (embedded-subtitle-sources.ts). It lands here as if it had
   *  none, so this step says it was not checked. */
  captionsNotRead?: boolean
}

type T = ReturnType<typeof useT>

/** Why transcribing isn't available, as one or two sentences. */
export function transcribeBlockReason(t: T, block: TranscribeBlock, after?: string): string {
  const role = (floor: number) => {
    const key = roleNameKey(floor)
    return key ? t(key, { count: 1 }) : String(floor)
  }
  const reason = block.kind === "import"
    ? t("audio.transcribeBlock.import", { role: role(block.floor) })
    // AQU-2426 (review, Nov 9): locked timing keeps the split for Maintainers.
    : block.kind === "timingLocked"
      ? t("audio.transcribeBlock.timingLocked", { role: role(block.floor) })
      : t(block.kind === "creditsToday" ? "audio.transcribeBlock.creditsToday" : "audio.transcribeBlock.creditsWeek")
  return after ? `${reason} ${after}` : reason
}

function formatSize(bytes: number, locale: string): string {
  const mb = bytes / (1024 * 1024)
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: mb < 10 ? 1 : 1, minimumFractionDigits: 1 }).format(mb)} MB`
}

export function RecordingImportChoiceDialog({
  files, block, cost, languageTag, credits, busy = false, onWhole, onTranscribe, onCancel,
}: {
  files: readonly RecordingChoiceFile[]
  /** Why this person can't transcribe here, or null when they can. */
  block: TranscribeBlock | null
  cost: TranscriptionCost
  languageTag?: string
  credits?: string | null
  busy?: boolean
  onWhole(): void
  onTranscribe(): void
  onCancel(): void
}) {
  const t = useT()
  const { locale } = useI18n()
  const [step, setStep] = useState<"choose" | "cost">("choose")
  const [whyOpen, toggleWhy] = useInfoOpen()
  const whyId = useId()
  const many = files.length > 1
  const name = files[0]?.name ?? ""
  const total = files.reduce((sum, f) => sum + (f.durationMs ?? 0), 0)
  const unchecked = files.filter((f) => f.captionsNotRead)

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel() }}>
      <DialogContent className="sm:max-w-2xl" data-testid="recording-import-choice">
        {step === "choose" ? (
          <>
            <DialogHeader>
              <DialogTitle>{many ? t("importExport.recordingChoice.titleMany", { count: files.length }) : t("importExport.recordingChoice.title", { name })}</DialogTitle>
              <DialogDescription>{many
                ? t("importExport.recordingChoice.descriptionMany", { count: files.length })
                : t("importExport.recordingChoice.description")}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <div className="flex flex-col gap-5">
                <ul aria-label={t("importExport.recordingChoice.list")} className="overflow-hidden rounded-md border border-border">
                  {files.map((f, i) => {
                    const Icon = f.isVideo ? FileVideo : FileAudio
                    return (
                      <li key={`${f.name}-${i}`} className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-b-0">
                        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                        <span className="text-xs text-muted-foreground">{formatSize(f.sizeBytes, locale)}</span>
                        <span className="w-16 text-end font-mono text-xs tabular-nums text-muted-foreground">
                          {f.durationMs !== undefined ? fmtCueClock(f.durationMs / 1000) : "–"}
                        </span>
                      </li>
                    )
                  })}
                  {many && (
                    <li className="flex items-center gap-2 bg-muted/40 px-2 py-1.5">
                      <span className="flex-1 text-sm text-muted-foreground">{t("importExport.recordingChoice.inAll")}</span>
                      <span className="text-sm font-medium">{audioLength(t, total)}</span>
                    </li>
                  )}
                </ul>
                <p className="text-sm text-muted-foreground">{t(many ? "importExport.recordingChoice.wholeNoteMany" : "importExport.recordingChoice.wholeNote")}</p>
                {unchecked.length > 0 && (
                  <p className="text-sm text-muted-foreground" data-testid="recording-import-captions-unread">
                    {unchecked.length === 1
                      ? t("importExport.recordingChoice.captionsNotRead", { name: unchecked[0]!.name, maxSize: captionFileLimitLabel(locale) })
                      : t("importExport.recordingChoice.captionsNotReadMany", { count: unchecked.length, maxSize: captionFileLimitLabel(locale) })}
                  </p>
                )}
              </div>
            </DialogBody>
            <DialogFooter className="sm:flex-col sm:items-stretch">
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={onCancel} disabled={busy}>{t("common.cancel")}</Button>
                <Button variant="outline" onClick={onWhole} disabled={busy} data-testid="recording-import-whole">
                  {t("importExport.recordingChoice.import")}
                </Button>
                <span className="inline-flex items-center gap-0.5">
                  <Button variant="outline" disabled={busy || block !== null} onClick={() => setStep("cost")}
                    data-testid="recording-import-transcribe">
                    <Sparkles data-icon="inline-start" />
                    {t("importExport.recordingChoice.importTranscribe")}
                  </Button>
                  {block && <InfoToggle open={whyOpen} onToggle={toggleWhy} controls={whyId}
                    label={t("importExport.recordingChoice.whyNot")} testId="recording-import-why" />}
                </span>
              </div>
              {block && (
                <div className="flex justify-end">
                  <InfoReveal open={whyOpen} id={whyId} className="max-w-[420px] text-xs text-muted-foreground">
                    {transcribeBlockReason(t, block, t("importExport.recordingChoice.later"))}
                  </InfoReveal>
                </div>
              )}
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex min-w-0 items-center gap-2">
                <Button variant="ghost" size="icon-sm" className="-ms-2" aria-label={t("common.back")}
                  onClick={() => setStep("choose")} disabled={busy}>
                  <ArrowLeft />
                </Button>
                <span className="min-w-0 truncate">{many
                  ? t("importExport.recordingChoice.costTitleMany", { count: files.length })
                  : t("importExport.recordingChoice.costTitle", { name })}</span>
              </DialogTitle>
            </DialogHeader>
            <DialogBody>
              <div className="flex flex-col gap-5">
                <TranscriptionCostLines cost={cost} languageTag={languageTag} credits={credits} testId="recording-import-cost" />
                <p className="text-sm text-muted-foreground">{t("importExport.recordingChoice.findsLines")}</p>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={onCancel} disabled={busy}>{t("common.cancel")}</Button>
              <Button onClick={onTranscribe} disabled={busy} data-testid="recording-import-transcribe-go">
                <Sparkles data-icon="inline-start" />
                {t("importExport.recordingChoice.transcribeAndImport")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
