// AQU-2204 (Sam, Oct 26): the file's ONE timing control — "Follows source" or
// "Follows recordings" — replacing the Original's timing / Free timing switch.
//
// The per-track "sets the timing" flags the Timing Modes canvas explored were
// set aside as too much for most people; what is left is these two choices,
// which are the timeline's two existing modes under plain names. Nothing about
// the stored value changes ("dubbing" / "audioFirst"), so this is a control, not
// a migration.
//
// SELF-CONTAINED ON PURPOSE. It lives in the timeline's header today; the
// layout work moves the timeline's tools into a 40 px top bar beside the file's
// play controls, and that bar mounts this component as it is. Everything it
// needs arrives as props, and it reaches into nothing.
//
// Three states, one shape ("⏱ <choice>", "Timing" on hover — canvas board
// 55, option E: no "Timing:" label, and no length or (i) in the bar):
//   - changeable: the choice is a dropdown with the two choices and a line each;
//   - read-only (below project lead): the choice as plain text, the (i) says who
//     can change it;
//   - locked (a file timed to a film): "Follows source" as plain text, the (i)
//     says the lines are timed to the film.
//
// Board 22 as drawn: the menu opens with "What decides how long each line is",
// each choice shows how long the file comes out with it, and a last line says
// muting never moves anything. Board 55 moved what the bar's (i) said beside
// that heading, and the note about stand-in lines (`standInInfo`) to the
// menu's foot. Board 24: a file with nothing to follow (no times, no source
// audio) greys "Follows source" out with the reason.
import { ChevronDown, Info, Timer } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AppTooltip, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { AudioTimingMode } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"

const MODES: readonly AudioTimingMode[] = ["dubbing", "audioFirst"]

/** Each choice's name and its one line. */
const TIMING_CHOICE_KEYS: Record<AudioTimingMode, { name: MessageKey; line: MessageKey; lineLocked: MessageKey }> = {
  dubbing: {
    name: "editor.timeline.timingModeDubbing",
    line: "editor.timeline.timingModeDubbingHint",
    lineLocked: "editor.timeline.timingModeDubbingHintLocked",
  },
  audioFirst: {
    name: "editor.timeline.timingModeFree",
    line: "editor.timeline.timingModeFreeHint",
    lineLocked: "editor.timeline.timingModeFreeHintLocked",
  },
}

export interface TimingModeControlProps {
  /** The file's resolved choice. */
  mode: AudioTimingMode
  /** Change THIS FILE's choice. Absent = below project lead: read-only. */
  onChange?(mode: AudioTimingMode): void
  /** The file is timed to a film, so it can only follow its source. */
  filmTimed?: boolean
  /** The file has no times and no source audio: nothing to follow, so it can
   *  only follow its recordings (board 24). */
  sourceUnavailable?: boolean
  /** How long the file comes out with each choice, in seconds (null = none). */
  lengths?: Partial<Record<AudioTimingMode, number | null>>
  /** "bar": sized like the media view's top bar buttons (28 px, 0.8 rem). */
  size?: "default" | "bar"
  /** Why some lines show no times (the timeline has stand-in lines): an (i)
   *  at the foot of the menu. */
  standInInfo?: string
  className?: string
}

/** "16.8 s", "12 min 4 s", "1 h 3 min". */
function formatFileLength(t: TFunction, sec: number): string {
  if (sec < 59.95) return t("editor.timeline.timingLengthSeconds", { seconds: (Math.round(sec * 10) / 10).toFixed(1) })
  const whole = Math.round(sec)
  if (whole < 3600) return t("editor.timeline.timingLengthMinutes", { minutes: Math.floor(whole / 60), seconds: whole % 60 })
  return t("editor.timeline.timingLengthHours", { hours: Math.floor(whole / 3600), minutes: Math.floor((whole % 3600) / 60) })
}

/** The control's (i): a long explanation on hover or keyboard focus, so the
 *  header itself stays short (Sam, Oct 25). Exported for the timeline's one
 *  (i) about stand-in lines. */
export function TimingInfoButton({ label, text, testId }: { label: string; text: string; testId: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        closeOnClick={false}
        render={
          <button
            type="button"
            aria-label={label}
            data-testid={testId}
            className="inline-flex shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  )
}

export function TimingModeControl({
  mode, onChange, filmTimed = false, sourceUnavailable = false, lengths, size = "default", standInInfo, className,
}: TimingModeControlProps) {
  const bar = size === "bar"
  const t = useT()
  // A film-timed file is shown as following its source whatever reaches here,
  // and a file with nothing to follow as following its recordings: the
  // resolver already says so, and the control must never claim otherwise.
  const shown: AudioTimingMode = filmTimed ? "dubbing" : sourceUnavailable ? "audioFirst" : mode
  const name = t(TIMING_CHOICE_KEYS[shown].name)
  const changeable = Boolean(onChange) && !filmTimed
  const infoText = filmTimed
    ? t("editor.timeline.timingLockedFilm")
    : !changeable
      ? t("editor.timeline.timingInfoReadOnly")
      : sourceUnavailable
        ? t("editor.timeline.timingInfoNothingToFollow")
        : t("editor.timeline.timingInfo")
  const lengthOf = (m: AudioTimingMode): string | null => {
    const sec = lengths?.[m]
    return sec != null && Number.isFinite(sec) && sec > 0 ? formatFileLength(t, sec) : null
  }

  return (
    <div
      data-testid="tl-timing-mode"
      data-mode={shown}
      data-locked={filmTimed ? "film" : changeable ? undefined : "role"}
      className={cn("inline-flex shrink-0 items-center gap-1", bar ? "text-[0.8rem]" : "text-[11px]", className)}
    >
      {changeable ? (
        <DropdownMenu>
          <AppTooltip content={t("editor.timeline.timingTip")}>
            <DropdownMenuTrigger
              data-testid="tl-timing-mode-trigger"
              aria-label={t("editor.timeline.timingMenuAria", { mode: name })}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border border-border bg-background text-foreground/80 hover:bg-muted aria-expanded:bg-muted",
                bar ? "h-7 px-2.5" : "h-6 px-2",
              )}
            >
              <Timer className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="font-medium text-sky-700 dark:text-sky-300">{name}</span>
              <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            </DropdownMenuTrigger>
          </AppTooltip>
          <DropdownMenuContent align="start" className="w-80 min-w-80">
            <div data-testid="tl-timing-menu-heading" className="flex items-center gap-1 px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
              {t("editor.timeline.timingMenuHeading")}
              <TimingInfoButton label={t("editor.timeline.timingInfoAria")} text={infoText} testId="tl-timing-mode-info" />
            </div>
            <DropdownMenuRadioGroup
              value={shown}
              onValueChange={(next) => {
                const picked = next as AudioTimingMode
                if (picked && picked !== shown) onChange?.(picked)
              }}
            >
              {MODES.map((m) => {
                const unavailable = m === "dubbing" && sourceUnavailable
                const length = unavailable ? null : lengthOf(m)
                return (
                  <DropdownMenuRadioItem
                    closeOnClick
                    key={m}
                    value={m}
                    disabled={unavailable}
                    data-testid={`tl-timing-mode-${m}`}
                    className="items-start py-1.5"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="text-xs font-medium text-foreground">{t(TIMING_CHOICE_KEYS[m].name)}</span>
                        {length && (
                          <span data-testid={`tl-timing-mode-${m}-length`} className="font-mono text-[11px] tabular-nums text-muted-foreground">
                            {length}
                          </span>
                        )}
                      </span>
                      <span className="text-[11px] leading-snug text-muted-foreground">
                        {unavailable ? t("editor.timeline.timingSourceUnavailable") : t(TIMING_CHOICE_KEYS[m].line)}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <div data-testid="tl-timing-menu-mute-note" className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-muted-foreground">
              {t("editor.timeline.timingMenuMuteNote")}
            </div>
            {standInInfo && (
              <div className="flex items-center gap-1 px-2 pb-1.5 text-[11px] leading-snug text-muted-foreground">
                {t("editor.timeline.standInInfoAria")}
                <TimingInfoButton label={t("editor.timeline.standInInfoAria")} text={standInInfo} testId="tl-stand-in-info" />
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // Read-only: the choice as plain text; what the menu's (i) would say
        // is its hover text.
        <AppTooltip content={`${t("editor.timeline.timingTip")} · ${infoText}${standInInfo ? ` ${standInInfo}` : ""}`}>
          <span
            data-testid={`tl-timing-mode-${shown}`}
            tabIndex={0}
            className={cn("inline-flex items-center gap-1 px-1 text-foreground/70", bar ? "h-7" : "h-6")}
          >
            <Timer className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium">{name}</span>
          </span>
        </AppTooltip>
      )}
    </div>
  )
}
