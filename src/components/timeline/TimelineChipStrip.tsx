// The slim per-chip stats strip under the timeline lanes (2026-08-07 design):
// one line of pills describing the CURRENT chip — the selected one, else the
// one currently sounding, else the last one touched. The old full detail pane
// is gone; the real text table renders below this strip, so the strip carries
// only what is chip-specific: kind, timings, Diff, Overlap, Speaker/Camera,
// and the missing-audio badge.

import { VolumeX } from "lucide-react"
import { fmtClock } from "./format"
import { MISSING_AUDIO_MESSAGE } from "@/lib/audio/play-queue"
import { AppTooltip } from "@/components/ui/tooltip"
import type { CellData } from "@/hooks/useCells"
import { useT } from "@/lib/i18n/I18nProvider"

/** The current dub chip's own numbers, computed by TimelineEditor (this
 *  component never reads lane geometry). Null when there is no measured dub. */
export type ChipStats =
  | {
      kind: "dubbing"
      startSec: number
      endSec: number
      durationSec: number
      /** Dub start − original start: negative when the dub begins BEFORE its
       *  verse. Shown only in the Diff pill's hover. */
      startDiffSec: number | null
      /** Original end − dub end: negative when the dub outruns its verse.
       *  Shown only in the Diff pill's hover. */
      endDiffSec: number | null
      /** 2026-08-08 (Sam): the headline Diff — source duration − target
       *  duration (= startDiff + endDiff), positive exactly when the target
       *  is shorter. INFORMATIONAL (2026-08-06): a difference can be
       *  intentional — never styled as a warning. */
      durationDiffSec: number | null
      /** How much this chip double-sounds over the PREVIOUS chip
       *  (trespasser-gated, masked when that width is a guess). */
      headOverlapSec: number | null
      /** …and over the NEXT one. Overlap is ALWAYS a problem — shown red;
       *  both sides at once render as two labeled pills. */
      tailOverlapSec: number | null
    }
  | {
      /** Free timing (2026-08-06): file-clock ranges are meaningless
       *  against the re-flowed track — durations are the only honest
       *  numbers, so that's all this variant carries. */
      kind: "free"
      srcDurationSec: number | null
      tgtDurationSec: number | null
    }
  | null

export interface TimelineChipStripProps {
  cell: CellData | null
  chipStats?: ChipStats
  /** The current clip's stored recording is permanently gone (404). Shows a
   *  compact red pill — the chip's corner badge and the transport agree. */
  audioMissing?: boolean
}

/** One-decimal, explicitly signed seconds (− is the typographic minus so the
 *  readouts match the rest of the strip). */
function signedSec(sec: number): string {
  const tenths = Math.round(sec * 10) / 10
  return `${tenths < 0 ? "−" : "+"}${Math.abs(tenths).toFixed(1)}s`
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80">
      {children}
    </span>
  )
}

/** The compact segment-navigator slot on the strip's right (Sam 2026-08-07):
 *  EditorTable PORTALS its MilestoneNavigator here — the nav's items and
 *  scroll handlers live in the table, but the strip row is where it sits.
 *  The data-chapter-nav-slot marker drives the nav's own width-collapse; the
 *  [&_button] overrides shrink its size-8 buttons to a strip-friendly h-7. */
function StripNavSlot() {
  return (
    <div
      data-strip-nav-slot=""
      data-chapter-nav-slot=""
      data-testid="tl-strip-nav"
      // w-72 = the nav's xl-mode width exactly (fixed 224px trigger + two
      // 32px arrows) — anything narrower and the buttons run off-screen.
      className="ms-auto w-72 max-w-[45%] shrink-0 empty:hidden [&_button]:h-7 [&_button]:text-[11px]"
    />
  )
}

export function TimelineChipStrip({ cell, chipStats, audioMissing }: TimelineChipStripProps) {
  const t = useT()
  const isDialogue = (cell?.medium ?? "text") === "media"
  const start = cell?.startTime ?? 0
  const end = cell?.endTime ?? start
  const castName =
    cell?.metadata && typeof cell.metadata.cast_name === "string"
      ? (cell.metadata.cast_name as string)
      : null

  // ONE shared row in both states: the left side flips between the empty
  // prompt and the pills, while the nav slot keeps its DOM identity — the
  // table's portal host must survive selection changes.
  return (
    <div className="flex items-center gap-2 border-t border-border bg-muted/20 px-4 py-1.5">
      {!cell ? (
        <div data-testid="tl-detail-empty" className="flex min-w-0 items-center text-xs text-muted-foreground">
          {t("workspace.chipStrip.selectClipPrompt")}
        </div>
      ) : (
      <div
        data-testid="tl-detail"
        data-cell-id={cell.id}
        className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground"
      >
        {/* Same heading treatment as the toolbar's "Timeline" — a section
            label, not a data pill (Sam 2026-08-07). */}
        <span className="text-xs font-medium text-muted-foreground">
          {isDialogue ? "Dialogue" : "Subtitle"}
        </span>
        {/* Free timing: no ranges — the file clock doesn't match the
            re-flowed track. Durations only (2026-08-06). */}
        {chipStats?.kind === "free" ? (
          <>
            {chipStats.srcDurationSec != null && (
              <Pill>
                <span data-testid="tl-detail-src-duration" className="font-mono tabular-nums">
                  {t("workspace.chipStrip.sourceLabel")} {chipStats.srcDurationSec.toFixed(1)}s
                </span>
              </Pill>
            )}
            {chipStats.tgtDurationSec != null && (
              <Pill>
                <span data-testid="tl-detail-tgt-duration" className="font-mono tabular-nums">
                  {t("workspace.chipStrip.targetLabel")} {chipStats.tgtDurationSec.toFixed(1)}s
                </span>
              </Pill>
            )}
          </>
        ) : (
          <Pill>
            <span className="font-mono tabular-nums">
              {chipStats ? `${t("workspace.chipStrip.sourceLabel")} ` : ""}
              {fmtClock(start, true)}–{fmtClock(end, true)}
              {" · "}
              {(end - start).toFixed(1)}s
            </span>
          </Pill>
        )}
        {chipStats?.kind === "dubbing" && (
          <Pill>
            <span data-testid="tl-detail-dub-range" className="font-mono tabular-nums">
              {t("workspace.chipStrip.targetLabel")} {fmtClock(chipStats.startSec, true)}–{fmtClock(chipStats.endSec, true)}
              {" · "}
              <span data-testid="tl-detail-duration">{chipStats.durationSec.toFixed(1)}s</span>
            </span>
          </Pill>
        )}
        {chipStats?.kind === "dubbing" &&
          chipStats.durationDiffSec != null &&
          (() => {
            // One-decimal display; the sign follows the DISPLAYED value.
            // INFORMATIONAL by decision (2026-08-06): a length difference can
            // be intentional — chip OVERLAP below is the warning. The hover
            // keeps the halves for anyone who needs to know WHERE it differs
            // (2026-08-08).
            const parts = [
              chipStats.startDiffSec != null
                ? t("workspace.chipStrip.diffStartDetail", { value: signedSec(chipStats.startDiffSec) })
                : null,
              chipStats.endDiffSec != null
                ? t("workspace.chipStrip.diffEndDetail", { value: signedSec(chipStats.endDiffSec) })
                : null,
            ].filter((part): part is string => part !== null)
            return (
              <Pill>
                <AppTooltip
                  content={
                    parts.length > 0
                      ? t("workspace.chipStrip.durationDiffTooltipWithDetail", { detail: parts.join(" · ") })
                      : t("workspace.chipStrip.durationDiffTooltip")
                  }
                >
                  <span data-testid="tl-detail-diff" className="font-mono tabular-nums">
                    {t("workspace.chipStrip.diffLabel")} {signedSec(chipStats.durationDiffSec)}
                  </span>
                </AppTooltip>
              </Pill>
            )
          })()}
        {/* Overlap: one side → one plain pill (today's shape); BOTH sides →
            two labeled pills, because a single summed number would say
            nothing about where the collision is (Sam 2026-08-08). */}
        {chipStats?.kind === "dubbing" &&
          chipStats.headOverlapSec != null &&
          chipStats.tailOverlapSec != null && (
            <>
              <Pill>
                <span
                  data-testid="tl-detail-overlap-start"
                  title={t("workspace.chipStrip.startOverlapTooltip")}
                  className="font-mono tabular-nums font-semibold text-red-600 dark:text-red-400"
                >
                  {t("workspace.chipStrip.startOverlapValue", { sec: chipStats.headOverlapSec.toFixed(1) })}
                </span>
              </Pill>
              <Pill>
                <span
                  data-testid="tl-detail-overlap-end"
                  title={t("workspace.chipStrip.endOverlapTooltip")}
                  className="font-mono tabular-nums font-semibold text-red-600 dark:text-red-400"
                >
                  {t("workspace.chipStrip.endOverlapValue", { sec: chipStats.tailOverlapSec.toFixed(1) })}
                </span>
              </Pill>
            </>
          )}
        {chipStats?.kind === "dubbing" &&
          (chipStats.headOverlapSec == null) !== (chipStats.tailOverlapSec == null) && (
            <Pill>
              <span
                data-testid="tl-detail-overlap"
                title={t("workspace.chipStrip.eitherOverlapTooltip")}
                className="font-mono tabular-nums font-semibold text-red-600 dark:text-red-400"
              >
                {t("workspace.chipStrip.overlapValue", {
                  sec: (chipStats.headOverlapSec ?? chipStats.tailOverlapSec ?? 0).toFixed(1),
                })}
              </span>
            </Pill>
          )}
        {audioMissing && (
          <Pill>
            <span
              data-testid="tl-detail-audio-missing"
              role="status"
              className="inline-flex items-center gap-1 font-medium text-red-600 dark:text-red-400"
            >
              <VolumeX className="h-3 w-3 shrink-0" />
              {MISSING_AUDIO_MESSAGE}
            </span>
          </Pill>
        )}
        {castName && (
          <Pill>
            {t("workspace.chipStrip.speakerLabel")} <b className="font-semibold text-foreground">{castName}</b>
          </Pill>
        )}
        {isDialogue && cell.cameraState && (
          <Pill>
            {t("importExport.labels.previewCameraHeader")} <b className="font-semibold text-foreground">{cell.cameraState}</b>
          </Pill>
        )}
      </div>
      )}
      <StripNavSlot />
    </div>
  )
}
