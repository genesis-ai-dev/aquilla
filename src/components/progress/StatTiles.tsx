import { InfoNote } from "@/components/ui/info-note"
import { useT } from "@/lib/i18n/I18nProvider"
import { progressPercent, progressPercentOfFraction } from "@/lib/progress/progress-percent"
import { PROGRESS_BG, type ProgressTone } from "@/lib/progress/progress-palette"
import { cn } from "@/lib/utils"

// ── Stat tiles (big %) ────────────────────────────────────────────────────────

/**
 * AQU-1764 (Sam, 2026-10-13, "Layout A, softest"): the number is in the text
 * colour, and the colour lives in a small swatch before the label — the same
 * tone that measure's bar below is drawn in (AI drafted: the stripes). The
 * numbers used to be amber, violet, emerald and sky, four colours that meant
 * nothing anywhere else.
 */
export function StatTile({ label, pct, tone, muted = false, tooltip }: {
  label: string
  pct: number
  tone: ProgressTone
  /** A cross-language figure while one language is selected: greyed, swatch faded. */
  muted?: boolean
  /** What the figure measures. AQU-2260 (Sam, Oct 29): it opens on a click of
   *  the (i) by the label, in a note anchored to it; the tile no longer
   *  explains itself on hover. */
  tooltip?: string
}) {
  const t = useT()
  return (
    <div className="flex flex-col items-center rounded-lg bg-muted/40 px-5 py-3 text-center">
      <p className={`text-2xl font-bold tabular-nums ${muted ? "text-muted-foreground/60" : "text-foreground"}`}>
        {`${progressPercentOfFraction(pct)}%`}
      </p>
      <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span
          aria-hidden
          data-progress-swatch={tone}
          className={cn("h-1.5 w-3.5 shrink-0 rounded-full", PROGRESS_BG[tone], muted && "opacity-40")}
        />
        {label}
        {tooltip ? (
          <InfoNote label={t("common.aboutAria", { name: label })} iconClassName="h-3 w-3" align="center">
            {tooltip}
          </InfoNote>
        ) : null}
      </p>
    </div>
  )
}

// ── Stat bar ──────────────────────────────────────────────────────────────────

/**
 * One measure, one bar, one colour, starting at zero (AQU-1764, "Layout A"):
 * the card keeps a separate bar per measure, so each reads by its length alone,
 * in that measure's tone from the shared progress palette.
 */
export function StatBar({ label, value, total, tone, suffix }: {
  label: string
  value: number
  total: number
  tone: ProgressTone
  suffix?: string
}) {
  const pct = progressPercent(value, total)
  return (
    <div className="flex items-center gap-3" data-testid={`stat-bar-${tone}`}>
      {/* w-28, not w-20: "Audio Validated" (AQU-1764 added its bar) is the
          longest label and wrapped onto two lines at 80px. */}
      <span className="w-28 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-1 items-center gap-2">
        <span className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
          <span
            className={`block h-full rounded-full transition-all ${PROGRESS_BG[tone]}`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="w-20 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
          {pct}%
        </span>
      </div>
      <span className="w-28 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground/70">
        {value}/{total}{suffix ? ` ${suffix}` : ""}
      </span>
    </div>
  )
}
