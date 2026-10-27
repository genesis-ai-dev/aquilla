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
// Three states, one shape ("Timing: <choice>" with an (i) beside it):
//   - changeable: the choice is a dropdown with the two choices and a line each;
//   - read-only (below project lead): the choice as plain text, the (i) says who
//     can change it;
//   - locked (a file timed to a film): "Follows source" as plain text, the (i)
//     says the lines are timed to the film.
import { ChevronDown, Info, Timer } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { AudioTimingMode } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"

const MODES: readonly AudioTimingMode[] = ["dubbing", "audioFirst"]

/** Each choice's name and its one line. */
export const TIMING_CHOICE_KEYS: Record<AudioTimingMode, { name: MessageKey; line: MessageKey; lineLocked: MessageKey }> = {
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
  className?: string
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

export function TimingModeControl({ mode, onChange, filmTimed = false, className }: TimingModeControlProps) {
  const t = useT()
  // A film-timed file is shown as following its source whatever reaches here:
  // the resolver already says so, and the control must never claim otherwise.
  const shown: AudioTimingMode = filmTimed ? "dubbing" : mode
  const name = t(TIMING_CHOICE_KEYS[shown].name)
  const changeable = Boolean(onChange) && !filmTimed
  const infoText = filmTimed
    ? t("editor.timeline.timingLockedFilm")
    : changeable
      ? t("editor.timeline.timingInfo")
      : t("editor.timeline.timingInfoReadOnly")

  return (
    <div
      data-testid="tl-timing-mode"
      data-mode={shown}
      data-locked={filmTimed ? "film" : changeable ? undefined : "role"}
      className={cn("inline-flex shrink-0 items-center gap-1 text-[11px]", className)}
    >
      {changeable ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="tl-timing-mode-trigger"
            aria-label={t("editor.timeline.timingMenuAria", { mode: name })}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-foreground/80 hover:bg-muted aria-expanded:bg-muted"
          >
            <Timer className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="text-muted-foreground">{t("editor.timeline.timingLabel")}</span>
            <span className="font-medium text-sky-700 dark:text-sky-300">{name}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-80 min-w-80">
            <DropdownMenuRadioGroup
              value={shown}
              onValueChange={(next) => {
                const picked = next as AudioTimingMode
                if (picked && picked !== shown) onChange?.(picked)
              }}
            >
              {MODES.map((m) => (
                <DropdownMenuRadioItem
                  closeOnClick
                  key={m}
                  value={m}
                  data-testid={`tl-timing-mode-${m}`}
                  className="items-start py-1.5"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-xs font-medium text-foreground">{t(TIMING_CHOICE_KEYS[m].name)}</span>
                    <span className="text-[11px] leading-snug text-muted-foreground">{t(TIMING_CHOICE_KEYS[m].line)}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span
          data-testid={`tl-timing-mode-${shown}`}
          className="inline-flex h-6 items-center gap-1 px-1 text-foreground/70"
        >
          <Timer className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="text-muted-foreground">{t("editor.timeline.timingLabel")}</span>
          <span className="font-medium">{name}</span>
        </span>
      )}
      <TimingInfoButton label={t("editor.timeline.timingInfoAria")} text={infoText} testId="tl-timing-mode-info" />
    </div>
  )
}
