// AQU-2426: Split into lines… (board 58, part 3). On any source recording, at
// any length, from any way in — never on a take, which keeps Split at the
// playhead.
//
//   • At pauses — free, no AI — is chosen when it opens, with its preview drawn
//     at once: the line's waveform, a mark at each cut, numbered parts, and
//     the count and range of the lines it makes. A click on a part plays it.
//   • At sentences, with words shows what it will cost first; its button
//     transcribes, then the preview shows the cuts at sentence ends and each
//     line's words. Cancel after that keeps the words on the line (they were
//     paid for); nothing is split. Cancel while it is still transcribing
//     stops it: no further minute is sent, and nothing is written.
//   • Someone who may not transcribe sees At sentences greyed, with a click (i)
//     saying what it does and why it isn't available here.
//   • A translation or takes already on the line stay on the first new line,
//     and the dialog says so above its buttons.
// Nothing changes until Split is pressed.

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { fmtCueClock } from "@/components/timeline/format"
import { TranscriptionCostLines, modelName, runLength } from "@/components/import/TranscriptionCostLines"
import { transcribeBlockReason } from "@/components/import/RecordingImportChoiceDialog"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import type { FrontierSession } from "@/lib/frontier/types"
import type { TranscribeBlock } from "@/lib/audio/transcribe-access"
import type { TranscriptionCost } from "@/lib/audio/transcription-cost"
import {
  cutsFromWords, loadLinePcm, pauseCuts, PCM_RATE, previewPeaks, type LineAudio,
} from "@/lib/audio/recording-split"
import { runLineWords } from "@/lib/audio/line-words-run"
import type { WordLine } from "@/lib/audio/lines-from-words"
import { piecesFromCuts, type LineHeard, type LinePiece } from "@/lib/timeline/split-recording-line"

export type SplitMode = "pauses" | "sentences"

const LANE_COLUMNS = 315
const LANE_H = 112

type T = ReturnType<typeof useT>

function rangeLine(t: T, pieces: readonly LinePiece[]): string | null {
  if (pieces.length < 2) return null
  const lens = pieces.map((p) => (p.trimEndMs - p.trimStartMs) / 1000)
  return t("editor.splitLines.lineRange", {
    min: Math.max(1, Math.round(Math.min(...lens))),
    max: Math.max(1, Math.round(Math.max(...lens))),
  })
}

/** Plays one part of the line from the PCM already read. */
function usePartPlayer() {
  const ctxRef = useRef<AudioContext | null>(null)
  const srcRef = useRef<AudioBufferSourceNode | null>(null)
  useEffect(() => () => {
    srcRef.current?.stop()
    void ctxRef.current?.close().catch(() => {})
  }, [])
  return (pcm: Float32Array, startSample: number, endSample: number) => {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      ctxRef.current ??= new Ctx()
      const ctx = ctxRef.current
      srcRef.current?.stop()
      const part = pcm.subarray(Math.max(0, startSample), Math.min(pcm.length, endSample))
      if (part.length === 0) return
      const buffer = ctx.createBuffer(1, part.length, PCM_RATE)
      buffer.copyToChannel(new Float32Array(part), 0)
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      src.start()
      srcRef.current = src
    } catch {
      // Playback is a convenience; the split doesn't depend on it.
    }
  }
}

/** The line's waveform with a mark at each cut and the parts numbered (Station lane look). */
function SplitPreview({ peaks, lo, hi, pieces, onPlay, label }: {
  peaks: readonly number[]
  lo: number
  hi: number
  pieces: readonly LinePiece[]
  onPlay(piece: LinePiece, index: number): void
  label: string
}) {
  const t = useT()
  const W = LANE_COLUMNS * 2
  const span = Math.max(1, hi - lo)
  const x = (ms: number) => ((ms - lo) / span) * W
  const mid = LANE_H / 2
  const dense = pieces.length > W / 14
  return (
    <svg role="group" aria-label={label} viewBox={`0 0 ${W} ${LANE_H}`} preserveAspectRatio="none"
      className="h-28 w-full rounded-md border border-border bg-muted/30" data-testid="split-preview">
      {peaks.map((p, i) => {
        const h = Math.max(1, p * (LANE_H - 24))
        return <rect key={i} x={i * 2} y={mid - h / 2} width={1.4} height={h} className="fill-[#0e9bd6]/70" />
      })}
      {pieces.map((piece, i) => {
        const x0 = x(piece.trimStartMs)
        const x1 = x(piece.trimEndMs)
        const w = Math.max(0, x1 - x0)
        return (
          <g key={i}>
            <rect x={x0} y={0} width={w} height={LANE_H} className="cursor-pointer fill-transparent hover:fill-foreground/5"
              role="button" tabIndex={dense ? -1 : 0}
              aria-label={t("editor.splitLines.partLabel", {
                number: i + 1, start: fmtCueClock(piece.trimStartMs / 1000), end: fmtCueClock(piece.trimEndMs / 1000),
              })}
              onClick={() => onPlay(piece, i)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPlay(piece, i) } }} />
            {i > 0 && (dense
              ? <rect x={x0 - 0.5} y={LANE_H - 10} width={1} height={10} className="pointer-events-none fill-foreground/70" />
              : <rect x={x0 - 0.75} y={0} width={1.5} height={LANE_H} className="pointer-events-none fill-foreground/80" />)}
            {!dense && w >= 14 && (
              <text x={x0 + w / 2} y={12} textAnchor="middle" className="pointer-events-none fill-muted-foreground text-[10px] tabular-nums">
                {i + 1}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export interface SplitIntoLinesDialogProps {
  name: string
  /** Where the line sits on the timeline, ms. */
  startMs: number
  endMs: number
  durationMs?: number
  audio: LineAudio
  session: FrontierSession | null
  languageTag?: string
  /** What At sentences, with words will cost for this line. */
  wordsCost: TranscriptionCost
  credits?: string | null
  block: TranscribeBlock | null
  initialMode?: SplitMode
  /** The line already has a translation or takes. */
  keepsLine: boolean
  /** AQU-2426 × AQU-2375: keep the words run under this line, so a reload or a
   *  failed minute never loses words already paid for, and a later run on the
   *  same stretch sends only what is missing. Absent: not kept. */
  keepAs?: { cellId: string; audioId: string; fileName: string }
  /** Write the split; false when it failed (the dialog stays open). */
  onSplit(pieces: LinePiece[], heard?: LineHeard): Promise<boolean>
  /** Words came back but nothing was split: keep them on the line. */
  onKeepWords(text: string, heard?: LineHeard): void
  onClose(): void
}

export function SplitIntoLinesDialog(props: SplitIntoLinesDialogProps) {
  const { name, audio, session, block, wordsCost, credits, languageTag, keepsLine } = props
  const t = useT()
  const [mode, setMode] = useState<SplitMode>(props.initialMode === "sentences" && !block ? "sentences" : "pauses")
  const [pcm, setPcm] = useState<Float32Array | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [words, setWords] = useState<{ lines: WordLine[]; cuts: number[]; texts: string[]; text: string } | null>(null)
  const [transcribing, setTranscribing] = useState<"no" | "running" | "waiting">("no")
  const [transcribeError, setTranscribeError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [whyOpen, toggleWhy] = useInfoOpen()
  const whyId = useId()
  const play = usePartPlayer()
  const closed = useRef(false)
  const keptWords = useRef(false)
  /** Words from a run that didn't get every minute: they stay on the line. */
  const partialText = useRef("")
  // AQU-2426 (review, Nov 9): the timed words behind the text, so the lines
  // written from it get their word timings and what was heard as well.
  const heard = useRef<LineHeard | undefined>(undefined)
  // AQU-2426 / AQU-2375 (review, Nov 9): Cancel stops a transcription that is
  // still running, as does the dialog going away. It used to close and leave
  // every remaining minute to be sent and charged with nothing on screen.
  const stopRun = useRef<AbortController | null>(null)
  useEffect(() => () => stopRun.current?.abort(), [])

  useEffect(() => {
    let live = true
    loadLinePcm(audio, session).then(
      (data) => { if (live) setPcm(data) },
      (err) => { if (live) setReadError(err instanceof Error ? err.message : String(err)) },
    )
    return () => { live = false }
    // The line's stretch is fixed for the dialog's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const lineRef = useMemo(() => ({
    startMs: props.startMs, endMs: props.endMs, trimStartMs: audio.lo, trimEndMs: audio.hi, durationMs: props.durationMs,
  }), [props.startMs, props.endMs, audio.lo, audio.hi, props.durationMs])
  const pauseCutsMs = useMemo(() => (pcm ? pauseCuts(pcm, audio.lo) : null), [pcm, audio.lo])
  const peaks = useMemo(() => (pcm ? previewPeaks(pcm, LANE_COLUMNS) : []), [pcm])
  const pieces = useMemo(() => {
    if (mode === "pauses") return pauseCutsMs ? piecesFromCuts(lineRef, pauseCutsMs) : null
    return words ? piecesFromCuts(lineRef, words.cuts, words.texts) : null
  }, [mode, pauseCutsMs, words, lineRef])

  const keepWordsOnce = (text: string) => {
    if (keptWords.current || !text.trim()) return
    keptWords.current = true
    props.onKeepWords(text, heard.current)
  }
  const close = () => {
    closed.current = true
    stopRun.current?.abort()
    if (words) keepWordsOnce(words.text)
    else if (partialText.current) keepWordsOnce(partialText.current)
    props.onClose()
  }

  const transcribe = async () => {
    setTranscribing("running")
    setTranscribeError(null)
    const stop = new AbortController()
    stopRun.current = stop
    try {
      // A minute at a time, kept as it lands (line-words-run.ts); a kept run
      // on this stretch is taken over, so only what is missing is sent.
      const { report, handle } = await runLineWords({
        audio, session, ...(languageTag ? { languageTag } : {}),
        purpose: "dialog",
        signal: stop.signal,
        ...(props.keepAs ? { identity: { cellId: props.keepAs.cellId, audioId: props.keepAs.audioId, name: props.keepAs.fileName } } : {}),
        onRateLimited: async (sec) => {
          setTranscribing("waiting")
          await new Promise((r) => setTimeout(r, Math.max(1, sec) * 1000))
          setTranscribing("running")
        },
      })
      // The page is going (a reload): left as it is, for the next page.
      if (report.interrupted) return
      // Parked either way: nothing runs now, and the words wait for a split.
      handle?.park()
      heard.current = { words: report.words, ...(report.model ? { model: report.model } : {}) }
      // Stopped by Cancel with minutes still to do: nothing is written to the
      // line. The parked run keeps the words, so the next try sends the rest.
      if (report.cancelled) return
      if (report.done < report.total) {
        // Some minutes failed: no preview, and the words so far stay put.
        partialText.current = report.text
        if (closed.current) {
          keepWordsOnce(report.text)
          return
        }
        setTranscribeError(t("audio.lineWords.dialogPartial", {
          done: report.done, count: report.total, reason: report.failed[0]?.message ?? "",
        }))
        return
      }
      partialText.current = ""
      const cut = cutsFromWords(report.words, audio)
      if (closed.current) {
        // Cancelled while it ran: the words were paid for, so they stay.
        keepWordsOnce(report.text)
        return
      }
      setWords({ ...cut, text: report.text })
    } catch (err) {
      if (!closed.current) setTranscribeError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!closed.current) setTranscribing("no")
    }
  }

  const split = async () => {
    if (!pieces || pieces.length < 2) return
    setBusy(true)
    const ok = await props.onSplit(pieces, mode === "sentences" ? heard.current : undefined)
    if (ok) {
      // AQU-2426 (review, Nov 9): the kept words stay kept (parked) after the
      // split. Dropped here, Undo left a whole line whose words had to be
      // paid for again.
      closed.current = true
      props.onClose()
    } else setBusy(false)
  }

  const sentencesHint = wordsCost.onDevice
    ? t("editor.splitLines.atSentencesOnDevice")
    : words
      ? t("editor.splitLines.atSentencesDone", { count: words.lines.length })
      : t("editor.splitLines.atSentencesCost", {
          requests: t("editor.splitLines.requestCount", { count: wordsCost.requests }),
          time: t("editor.splitLines.aboutLower", { length: runLength(t, wordsCost.seconds) }),
          model: modelName(t, wordsCost),
        })
  const needsWords = mode === "sentences" && !words
  const status = readError
    ? t("editor.splitLines.readFailed", { reason: readError })
    : transcribing === "waiting"
      ? t("editor.splitLines.waiting")
      : transcribing === "running"
        ? t("editor.splitLines.transcribing")
        : !pcm
          ? t("editor.splitLines.reading")
          : null

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) close() }}>
      <DialogContent className="sm:max-w-2xl" data-testid="split-into-lines">
        <DialogHeader>
          <DialogTitle>{t("editor.splitLines.title", { name })}</DialogTitle>
          <DialogDescription>{t("editor.splitLines.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-5">
            <Field>
              <FieldLabel>{t("editor.splitLines.where")}</FieldLabel>
              <RadioGroup value={mode} onValueChange={(v) => setMode(v as SplitMode)} className="flex flex-col gap-2">
                <label className={cn("flex cursor-pointer gap-2 rounded-md border p-2.5",
                  mode === "pauses" ? "border-primary/30 bg-primary/5" : "border-border bg-background")}>
                  <RadioGroupItem value="pauses" className="mt-0.5" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium">{t("editor.splitLines.atPauses")}</span>
                    <span className="text-sm text-muted-foreground">{t("editor.splitLines.atPausesHint")}</span>
                  </span>
                </label>
                <label className={cn("flex gap-2 rounded-md border p-2.5",
                  block ? "cursor-default" : "cursor-pointer",
                  mode === "sentences" ? "border-primary/30 bg-primary/5" : "border-border bg-background")}>
                  <RadioGroupItem value="sentences" className="mt-0.5" disabled={block !== null || busy} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn("text-sm font-medium", block && "opacity-50")}>{t("editor.splitLines.atSentences")}</span>
                      {block && <InfoToggle open={whyOpen} onToggle={toggleWhy} controls={whyId}
                        label={t("editor.splitLines.whatInfo")} />}
                    </span>
                    <span className={cn("text-sm text-muted-foreground", block && "opacity-50")}>{sentencesHint}</span>
                    {block && <InfoReveal open={whyOpen} id={whyId} className="text-xs text-muted-foreground">
                      {`${t("editor.splitLines.atSentencesWhat")} ${transcribeBlockReason(t, block)}`}
                    </InfoReveal>}
                  </span>
                </label>
              </RadioGroup>
            </Field>
            {needsWords ? (
              <div className="flex flex-col gap-3">
                <TranscriptionCostLines cost={wordsCost} languageTag={languageTag} credits={credits} />
                <p className="text-sm text-muted-foreground">{t("editor.splitLines.cutsAfterWords")}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {pieces && (
                  <p className="text-sm" role="status" data-testid="split-count">
                    <b className="font-medium">{t("editor.splitLines.lineCount", { count: pieces.length })}</b>
                    {pieces.length > 1 && <span className="text-muted-foreground">{" · "}{mode === "sentences"
                      ? t("editor.splitLines.eachWithWords")
                      : rangeLine(t, pieces)}</span>}
                  </p>
                )}
                {pcm && pieces && (
                  <SplitPreview peaks={peaks} lo={audio.lo} hi={audio.hi} pieces={pieces}
                    label={t("editor.splitLines.previewLabel")}
                    onPlay={(piece) => play(pcm,
                      Math.round(((piece.trimStartMs - audio.lo) / 1000) * PCM_RATE),
                      Math.round(((piece.trimEndMs - audio.lo) / 1000) * PCM_RATE))} />
                )}
                {pcm && pieces && pieces.length < 2 && mode === "pauses" && (
                  <p className="text-sm text-muted-foreground">{t("editor.splitLines.noPauses")}</p>
                )}
                {pcm && pieces && pieces.length > 1 && mode === "pauses" && (
                  <p className="text-xs text-muted-foreground">{t("editor.splitLines.clickToHear")}</p>
                )}
                {mode === "sentences" && words && pieces && (
                  <ol className="max-h-48 overflow-y-auto rounded-md border border-border" data-testid="split-words">
                    {pieces.map((p, i) => (
                      <li key={i} className="flex items-start gap-2 border-b border-border px-2 py-1.5 text-sm last:border-b-0">
                        <span className="w-7 shrink-0 pt-0.5 text-end text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                        <span className="w-[7.5rem] shrink-0 pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                          {fmtCueClock((p.trimStartMs - audio.lo) / 1000)} – {fmtCueClock((p.trimEndMs - audio.lo) / 1000)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{p.text}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
            {(status || transcribeError) && (
              <p role="status" className={cn("text-sm", (readError || transcribeError) ? "text-destructive" : "text-muted-foreground")}>
                {transcribeError ?? status}
              </p>
            )}
          </div>
        </DialogBody>
        <DialogFooter className="sm:flex-col sm:items-stretch">
          {keepsLine && <p className="text-xs text-muted-foreground sm:text-end">{t("editor.splitLines.keepsLine")}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={close} disabled={busy}>{t("common.cancel")}</Button>
            {needsWords ? (
              <Button onClick={() => void transcribe()} disabled={busy || transcribing !== "no" || block !== null}
                data-testid="split-transcribe">
                <Sparkles data-icon="inline-start" />
                {t("editor.splitLines.transcribePreview")}
              </Button>
            ) : (
              <Button onClick={() => void split()} disabled={busy || !pieces || pieces.length < 2}
                data-testid="split-go">
                {t("editor.splitLines.splitInto", { count: pieces?.length ?? 1 })}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
