// Importing an episode's audio VTT — the transcript of what is actually said
// in the film, which becomes the timeline's read-only Source-audio track.
// (AQU-646 stage 2)
//
// Two steps on purpose. The file is picked, parsed IN THE BROWSER, and its
// report shown before anything is uploaded, because the two VTTs an episode
// ships with are easy to confuse: pick the subtitle file by mistake and you
// would otherwise only discover it as a second, wrong-looking track. The cue
// count is the tell — the audio file has ~550 where the subtitle file has ~650.
//
// Every refusal is inline rather than a toast: the dialog is where the mistake
// was made and where the next attempt happens, and a toast fired from behind a
// modal is the message people miss.

import { useEffect, useMemo, useState } from "react"
import { v7 as uuidv7 } from "uuid"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { parseAudioVtt, scaleCueTimes, type ParsedAudioVtt } from "@/lib/import/audio-vtt"
import {
  planCueReconcile,
  type CueReconcilePlan,
  type ReconcilableCue,
} from "@/lib/import/cue-reconcile"
import {
  planTimebaseCorrection,
  type TimebaseCorrection,
  type TimebaseVerdict,
} from "@/lib/import/timebase"
import { decodeImportText, MAX_UNKNOWN_TEXT_BYTES } from "@/lib/import/ai-recipe"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import { fmtClock } from "./format"
import { autoLinkable, planCueLinks } from "@/lib/timeline/cue-links"

interface Props {
  open: boolean
  /** True when the file already has an audio-cue track: the import replaces it. */
  replacing: boolean
  /** The text file whose timeline gains the track — named so it is obvious
   *  which file the cues are about to be attached to. */
  textFileName: string
  /** The lines already on that text file — times AND words. The times give the
   *  frame grid the incoming cues are checked against; the words let the drift
   *  be measured directly, which is the check that actually holds up. See
   *  `timebase.ts`. Empty is fine and simply means no check is possible. */
  referenceLines?: readonly { startTime?: number; endTime?: number; original?: string }[]
  /** The cues already imported, if any. Lets the dialog reconcile against them
   *  — updating the cells that are already there instead of minting a new file
   *  — so takes and pairings survive. See `cue-reconcile.ts`. */
  existingCues?: readonly ReconcilableCue[]
  /** Does this cue carry a recording? Drives the orphan count in the
   *  confirmation, which is the number that decides it. */
  cueHasTake?: (cellId: string) => boolean
  /** `timebase` is the correction to APPLY: null when none was found, or when
   *  one was found and the user chose to keep the file's own timings. */
  onConfirm(
    parsed: ParsedAudioVtt,
    sourceFileName: string,
    timebase: TimebaseCorrection | null,
  ): void
  /** Update the cues already there rather than minting a new file. Newly added
   *  cues are paired automatically; re-deriving the REST lives in the pairing
   *  drawer, which is where you are when you decide they need redoing. */
  onReconcile?(plan: CueReconcilePlan): void
  /** Take the audio-cue track away entirely, without putting another in its
   *  place. Absent ⇒ not offered (no cues yet, or no clearance to delete). */
  onRemove?(): void
  /** How many recordings hang off the current cues — quoted in the removal
   *  confirmation, because it is the number that decides it. */
  takeCount?: number
  onCancel(): void
}

/** The span the cues cover, read off the first and last cue. */
function cueSpan(parsed: ParsedAudioVtt): string {
  const first = parsed.cues[0]?.start ?? 0
  const last = parsed.cues[parsed.cues.length - 1]?.end ?? 0
  return `${fmtClock(first)} – ${fmtClock(last)}`
}

export function ImportAudioVttDialog({
  open,
  replacing,
  textFileName,
  referenceLines,
  existingCues,
  cueHasTake,
  onConfirm,
  onReconcile,
  onRemove,
  takeCount = 0,
  onCancel,
}: Props) {
  const t = useT()
  const [picked, setPicked] = useState<{ parsed: ParsedAudioVtt; fileName: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Default ON: a detected mismatch is a defect in the file, and the whole
   *  point of detecting it is that nobody should have to know about frame
   *  rates to get a usable track. The opt-out exists because the evidence is
   *  statistical, not because declining is the ordinary choice. */
  const [correctTimebase, setCorrectTimebase] = useState(true)
  /** Removal asks twice, in place. It takes a whole track away and — when
   *  takes hang off the cues — puts recordings out of reach, so it does not
   *  get to be a single click sitting next to Cancel. */
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  useEffect(() => {
    if (open) {
      setPicked(null)
      setError(null)
      setCorrectTimebase(true)
      setConfirmingRemove(false)
    }
  }, [open])

  const verdict = useMemo<TimebaseVerdict | null>(() => {
    if (!picked || !referenceLines?.length) return null
    const cueTimes: number[] = []
    let lastCueSec = 0
    for (const cue of picked.parsed.cues) {
      if (typeof cue.start === "number") cueTimes.push(cue.start)
      if (typeof cue.end === "number") {
        cueTimes.push(cue.end)
        lastCueSec = Math.max(lastCueSec, cue.end)
      }
    }
    const referenceTimes: number[] = []
    for (const line of referenceLines) {
      if (typeof line.startTime === "number") referenceTimes.push(line.startTime)
      if (typeof line.endTime === "number") referenceTimes.push(line.endTime)
    }
    return planTimebaseCorrection({
      cueTimes,
      referenceTimes,
      lastCueSec,
      cueLines: picked.parsed.cues.map((c) => ({ startTime: c.start, original: c.original })),
      referenceLines,
    })
  }, [picked, referenceLines])

  /** The correction to APPLY, or null when there is nothing to apply. Keeps
   *  every downstream caller on the shape it already understands. */
  const timebase: TimebaseCorrection | null =
    verdict?.kind === "correct"
      ? {
          cue: verdict.cue,
          reference: verdict.reference,
          scale: verdict.scale,
          driftAtEndSec: verdict.driftAtEndSec,
        }
      : null

  /** The cues as they would actually be STORED — timebase applied if the user
   *  has left the correction on. Everything downstream compares against these,
   *  because comparing the raw file against corrected cues would report a
   *  three-second shift that the import was about to undo anyway. */
  const incomingCues = useMemo(() => {
    if (!picked) return []
    return timebase && correctTimebase
      ? scaleCueTimes(picked.parsed.cues, timebase.scale)
      : picked.parsed.cues
  }, [picked, timebase, correctTimebase])

  /**
   * How well the two files will actually line up — run BOTH ways when a
   * correction is on offer.
   *
   * The timebase question is otherwise a statistical claim a person has no way
   * to check. This turns it into one they can: "96% of the heard lines find a
   * subtitle with the correction, 61% without" is the same fact stated as the
   * thing they actually care about. Episode 306 imported wrong and stayed wrong
   * for days; those two numbers side by side would have made it obvious at the
   * moment of import.
   */
  const coverage = useMemo(() => {
    if (!picked || !referenceLines?.length) return null
    const textCells = referenceLines.map((l, i) => ({
      id: `r${i}`,
      startTime: l.startTime,
      endTime: l.endTime,
      original: l.original,
    }))
    const linkedFraction = (cues: readonly { start?: number; end?: number; original?: string }[]) => {
      const audioCues = cues.map((c, i) => ({
        id: `c${i}`,
        startTime: c.start,
        endTime: c.end,
        original: c.original,
      }))
      const paired = new Set(
        autoLinkable(planCueLinks({ textCells, audioCues })).map((p) => p.cueCellId),
      )
      return audioCues.length === 0 ? 0 : paired.size / audioCues.length
    }
    const applied = linkedFraction(incomingCues)
    return {
      applied,
      // Only worth computing — and only meaningful — when a correction is
      // actually on the table.
      raw: timebase ? linkedFraction(picked.parsed.cues) : null,
    }
  }, [picked, referenceLines, incomingCues, timebase])

  /**
   * Same cues, different timings? Then this is not a replacement.
   *
   * Replacing mints a new sibling file with new cell ids, which strands every
   * take recorded against the old cues (their bytes are stored under the old
   * file's path too). A retime edits the cells already there, so the ids never
   * change and takes and links both survive untouched.
   */
  const plan = useMemo(
    () =>
      existingCues?.length && onReconcile
        ? planCueReconcile({
            existing: existingCues,
            incoming: incomingCues,
            hasTake: cueHasTake,
            mintId: uuidv7,
          })
        : null,
    [existingCues, incomingCues, cueHasTake, onReconcile],
  )
  /** Nothing to write: same cues, same timings, none added or removed. */
  const planIsNoop =
    plan != null &&
    plan.retimes.length === 0 &&
    plan.creates.length === 0 &&
    plan.deletes.length === 0

  const handleFile = async (file: File) => {
    setPicked(null)
    setError(null)
    if (file.size === 0) {
      setError(t("editor.timeline.importFileEmpty"))
      return
    }
    if (file.size > MAX_UNKNOWN_TEXT_BYTES) {
      setError(t("editor.timeline.importTooLargeText", { fileName: file.name }))
      return
    }
    try {
      const parsed = parseAudioVtt(decodeImportText(await file.arrayBuffer(), file.name))
      if (parsed.cues.length === 0) {
        setError(t("editor.timeline.audioVttNoCues"))
        return
      }
      setPicked({ parsed, fileName: file.name })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const report = picked?.parsed.report

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="import-audio-vtt-dialog">
        <DialogHeader>
          <DialogTitle>
            {replacing
              ? t("editor.timeline.audioVttTitleReplace")
              : t("editor.timeline.audioVttTitleNew")}
          </DialogTitle>
          <DialogDescription>
            {t("editor.timeline.audioVttDescription", { fileName: textFileName })}
            {replacing && <> {t("editor.timeline.audioVttDescriptionReplacing")}</>}
          </DialogDescription>
        </DialogHeader>

        {picked && report ? (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">{picked.fileName}</p>
            <p className="text-muted-foreground">
              {t("editor.timeline.audioVttCueSummary", {
                count: report.totalCues,
                span: cueSpan(picked.parsed),
              })}
            </p>
            {report.repairedShortForm > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("editor.timeline.audioVttRepairedShortForm", {
                  count: report.repairedShortForm,
                })}
              </p>
            )}
            {report.strippedTagCues > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("editor.timeline.audioVttStrippedTags", {
                  count: report.strippedTagCues,
                })}
              </p>
            )}
            {report.droppedCues > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("editor.timeline.audioVttDroppedCues", { count: report.droppedCues })}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted p-6 text-center">
            <label>
              <span className="inline-flex cursor-pointer items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent">
                {t("editor.timeline.audioVttChoose")}
              </span>
              <input
                type="file"
                accept=".vtt"
                className="sr-only"
                data-testid="import-audio-vtt-input"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  // Clear the input so picking the SAME file again re-fires
                  // change — the usual second attempt after a refusal.
                  e.target.value = ""
                  if (file) void handleFile(file)
                }}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              {t("editor.timeline.audioVttPickHint")}
            </p>
          </div>
        )}

        {/* THE TIMING VERDICT, ALWAYS. Rendered in every state — corrected,
            already aligned, and couldn't tell — because the state that cost us
            a whole episode was the one that said nothing at all. Episode 306's
            subtitles were cut fine enough that their frame grid could not be
            read, so no correction was planned and no word of it appeared here;
            it imported drifting and only 61% of its lines ever found a partner.
            A refusal to guess is fine. An invisible refusal is not.

            The drift is stated in seconds, not in frame rates: the rates are
            the evidence, but "three seconds late by the end" is the thing
            anyone can check against the picture. */}
        {/* i18n-exempt "correct" is a TimebaseVerdict tag, not copy */}
        {picked && verdict?.kind === "correct" && (
          <div
            data-testid="import-audio-vtt-timebase"
            className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs"
          >
            <p>
              {verdict.namedRatio ? (
                <RichMessage
                  k="editor.timeline.audioVttTimebaseNamed"
                  values={{
                    rate: (
                      <span className="font-medium">
                        {t("editor.timeline.audioVttFramesPerSecond", {
                          rate: verdict.cue.label,
                        })}
                      </span>
                    ),
                    fileName: textFileName,
                    other: <span className="font-medium">{verdict.reference.label}</span>,
                  }}
                />
              ) : verdict.ambiguousRates ? (
                <RichMessage
                  k="editor.timeline.audioVttTimebaseAmbiguous"
                  values={{
                    rate: (
                      <span className="font-medium">
                        {t(
                          verdict.scale > 1
                            ? "editor.timeline.audioVttPercentFast"
                            : "editor.timeline.audioVttPercentSlow",
                          { percent: Math.abs((verdict.scale - 1) * 100).toFixed(1) },
                        )}
                      </span>
                    ),
                    fileName: textFileName,
                  }}
                />
              ) : (
                t("editor.timeline.audioVttTimebaseUnrecognised", { fileName: textFileName })
              )}{" "}
              <RichMessage
                k="editor.timeline.audioVttDriftTail"
                values={{
                  drift: (
                    <span className="font-medium">
                      {t(
                        verdict.driftAtEndSec > 0
                          ? "editor.timeline.audioVttSecondsEarly"
                          : "editor.timeline.audioVttSecondsLate",
                        { seconds: Math.abs(verdict.driftAtEndSec).toFixed(1) },
                      )}
                    </span>
                  ),
                }}
              />
            </p>
            {verdict.measured && (
              <p className="text-muted-foreground">
                {t("editor.timeline.audioVttMeasured", { count: verdict.measured.anchors })}
                {verdict.disputed && <> {t("editor.timeline.audioVttDisputed")}</>}
              </p>
            )}
            {coverage && coverage.raw != null && (
              <p data-testid="import-audio-vtt-coverage">
                <RichMessage
                  k="editor.timeline.audioVttCoverageCompare"
                  values={{
                    found: (
                      <span className="font-medium">
                        {t("editor.timeline.audioVttCoverageFound", {
                          percent: Math.round(coverage.applied * 100),
                        })}
                      </span>
                    ),
                    rawPercent: Math.round(coverage.raw * 100),
                  }}
                />
              </p>
            )}
            <label className="flex items-center gap-2">
              <Checkbox
                data-testid="import-audio-vtt-timebase-toggle"
                checked={correctTimebase}
                onCheckedChange={(checked) => setCorrectTimebase(checked)}
              />
              {t("editor.timeline.audioVttTimebaseApply", { fileName: textFileName })}
            </label>
          </div>
        )}

        {/* i18n-exempt "aligned" is a TimebaseVerdict tag, not copy */}
        {picked && verdict?.kind === "aligned" && (
          <div
            data-testid="import-audio-vtt-timebase-aligned"
            className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
          >
            {t("editor.timeline.audioVttTimebaseAligned", { fileName: textFileName })}
            {coverage && (
              <>
                {" "}
                <span className="font-medium text-foreground">
                  {t("editor.timeline.audioVttCoverageFoundSentence", {
                    percent: Math.round(coverage.applied * 100),
                  })}
                </span>
              </>
            )}
          </div>
        )}

        {/* i18n-exempt "unmeasurable" is a TimebaseVerdict tag, not copy */}
        {picked && verdict?.kind === "unmeasurable" && (
          <div
            data-testid="import-audio-vtt-timebase-unknown"
            className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs"
          >
            <p>
              <RichMessage
                k="editor.timeline.audioVttUnmeasurable"
                values={{
                  lead: (
                    <span className="font-medium">
                      {t("editor.timeline.audioVttUnmeasurableLead", {
                        fileName: textFileName,
                      })}
                    </span>
                  ),
                  reason: verdict.reason,
                }}
              />
            </p>
            {coverage && (
              <p data-testid="import-audio-vtt-coverage">
                <RichMessage
                  k="editor.timeline.audioVttCoverageAsDelivered"
                  values={{
                    found: (
                      <span className="font-medium">
                        {t("editor.timeline.audioVttCoverageFound", {
                          percent: Math.round(coverage.applied * 100),
                        })}
                      </span>
                    ),
                  }}
                />
              </p>
            )}
          </div>
        )}

        {/* What this import will actually DO to the cues already there. Stated
            as what survives, because that is the whole difference between
            reconciling and the replacement this took the place of: a cue that
            keeps its cell id keeps its recordings and its pairings, for free. */}
        {picked && plan && (
          <div
            data-testid="import-audio-vtt-reconcile"
            className="flex flex-col gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs"
          >
            {planIsNoop ? (
              <p>{t("editor.timeline.audioVttReconcileNoop", { count: plan.total })}</p>
            ) : (
              <>
                <p>
                  <RichMessage
                    k="editor.timeline.audioVttReconcileKept"
                    values={{
                      kept: (
                        <span className="font-medium">
                          {t("editor.timeline.audioVttKeptOfTotal", {
                            kept: plan.kept,
                            total: plan.total,
                          })}
                        </span>
                      ),
                    }}
                  />
                  {plan.keptTakes > 0 && (
                    <>
                      {" "}
                      <RichMessage
                        k="editor.timeline.audioVttKeptIncluding"
                        values={{
                          takes: (
                            <span className="font-medium">
                              {t("editor.timeline.audioVttRecordingCount", {
                                count: plan.keptTakes,
                              })}
                            </span>
                          ),
                        }}
                      />
                    </>
                  )}
                  {plan.retimes.length > 0 && (
                    <>
                      {". "}
                      {t("editor.timeline.audioVttRetimeShift", {
                        count: plan.retimes.length,
                        seconds: plan.maxShiftSec.toFixed(1),
                      })}
                    </>
                  )}
                  .
                </p>
                {(plan.creates.length > 0 || plan.deletes.length > 0) && (
                  <p>
                    {plan.creates.length > 0 && (
                      <>{t("editor.timeline.audioVttCreates", { count: plan.creates.length })} </>
                    )}
                    {plan.deletes.length > 0 &&
                      t("editor.timeline.audioVttDeletes", { count: plan.deletes.length })}
                  </p>
                )}
                {plan.orphanedTakes > 0 && (
                  <p data-testid="import-audio-vtt-orphan-warning" className="text-red-600 dark:text-red-400">
                    <RichMessage
                      k="editor.timeline.audioVttOrphanWarning"
                      values={{
                        lead: (
                          <span className="font-medium">
                            {t("editor.timeline.audioVttOrphanLead", {
                              count: plan.orphanedTakes,
                            })}
                          </span>
                        ),
                      }}
                    />
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {error && (
          <p
            data-testid="import-audio-vtt-error"
            className="text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}

        {/* Second step of the removal, in place rather than as a nested dialog
            — the same reason every refusal here is inline: this is where the
            decision is being made. `file.delete` is a SOFT delete, so takes are
            retained server-side even though nothing can reach them once the
            track is gone; that is worth saying, because "lost" and "out of
            reach" call for different amounts of nerve. */}
        {confirmingRemove && onRemove && (
          <div
            data-testid="import-audio-vtt-remove-confirm"
            className="flex flex-col gap-2 rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs"
          >
            <p>
              {t("editor.timeline.audioVttRemoveLead", {
                fileName: textFileName,
                count: existingCues?.length ?? 0,
              })}
              {takeCount > 0 && (
                <>
                  {" "}
                  <RichMessage
                    k="editor.timeline.audioVttRemoveTakes"
                    values={{
                      lead: (
                        <span className="font-medium">
                          {t("editor.timeline.audioVttRemoveTakesLead", { count: takeCount })}
                        </span>
                      ),
                    }}
                  />
                </>
              )}{" "}
              {t("editor.timeline.audioVttRemoveRestore")}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                data-testid="import-audio-vtt-remove-go"
                onClick={onRemove}
              >
                {t("editor.timeline.audioVttRemoveGo")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="import-audio-vtt-remove-cancel"
                onClick={() => setConfirmingRemove(false)}
              >
                {t("editor.timeline.keepThem")}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          {/* Pushed away from the confirming pair so it cannot be hit for one
              of them. Only when there is something to remove. */}
          {onRemove && !confirmingRemove && (
            <Button
              variant="ghost"
              data-testid="import-audio-vtt-remove"
              onClick={() => setConfirmingRemove(true)}
              className="mr-auto text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-400"
            >
              {t("editor.timeline.audioVttRemove")}
            </Button>
          )}
          <Button
            variant="outline"
            data-testid="import-audio-vtt-cancel"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="import-audio-vtt-confirm"
            // Dead only when there is genuinely nothing to do: no timings to
            // move AND no re-pairing asked for. Re-pairing alone is reason
            // enough to confirm, which is why it is not gated on a shift.
            disabled={!picked || planIsNoop}
            onClick={() => {
              if (!picked) return
              // The retime wins whenever it is available. It is strictly better
              // than the replacement it stands in for — same result on the
              // timeline, and takes and pairings survive rather than being
              // stranded — so there is no case for offering the worse one too.
              if (plan && onReconcile) {
                onReconcile(plan)
                return
              }
              onConfirm(picked.parsed, picked.fileName, correctTimebase ? timebase : null)
            }}
          >
            {!picked
              ? t("editor.timeline.audioVttImport")
              : plan
                ? planIsNoop
                  ? t("editor.timeline.audioVttNothingToUpdate")
                  : t("editor.timeline.audioVttUpdateCues", { count: plan.total })
                : t("editor.timeline.audioVttImportCues", {
                    count: picked.parsed.cues.length,
                  })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
