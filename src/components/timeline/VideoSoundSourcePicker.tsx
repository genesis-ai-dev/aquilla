// Which sound plays under a YouTube picture: the video's own, or the uploaded
// recording. (AQU-1565 follow-up)
//
// Sam, 2026-10-02: after uploading the original recording to a linked YouTube
// video, the picture went silent and followed the upload. The video's own
// sound and picture are the default now, and the recording plays only when
// somebody picks it here. The choice is remembered per file on this device
// (see lib/audio/playback-source.ts), like mute and the caption mode.
//
// It sits beside the film-language globe in the picture's bottom-right corner
// and has the same dark-glass look, and fades with the pointer like it.
//
// Sam, Oct 5: a speaker icon read as mute/unmute, so the trigger is a short
// text pill that names the current choice ("Sound: Video ▾" / "Sound:
// Recording ▾") and opens the menu, headed "Playback sound". The full choice
// ("Sound: The video's own sound") stays as its tooltip and accessible name.

import { useState } from "react"
import { Check, ChevronDown } from "lucide-react"

import { AppTooltip } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { PlaybackSource } from "@/lib/audio/playback-source"

export interface VideoSoundSourcePickerProps {
  value: PlaybackSource
  /** The uploaded recording's name, when it has one (the rows carry it). */
  recordingName: string | null
  onChange(source: PlaybackSource): void
  /** Held open across the corner's fade, like the language menu. */
  onOpenChange?(open: boolean): void
  /** "picture" (the default): dark glass over the video's corner. "lane": the
   *  timeline's Source audio lane label, beside its mute button, in the
   *  gutter's own light style (Sam, Oct 5). */
  variant?: "picture" | "lane"
  /** The lane's rows shrink; the pill shrinks with them, like the speaker. */
  compact?: boolean
}

export function VideoSoundSourcePicker({
  value,
  recordingName,
  onChange,
  onOpenChange,
  variant = "picture",
  compact = false,
}: VideoSoundSourcePickerProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const setOpenState = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }

  const recordingLabel = recordingName
    ? t("editor.timeline.soundSourceRecording", { name: recordingName })
    : t("editor.timeline.soundSourceRecordingUnnamed")
  const options: { source: PlaybackSource; label: string }[] = [
    { source: "video", label: t("editor.timeline.soundSourceVideo") },
    { source: "recording", label: recordingLabel },
  ]
  const active = options.find((o) => o.source === value) ?? options[0]
  const label = t("editor.timeline.soundSourceTrigger", { source: active.label })
  const pill = t(active.source === "recording" ? "editor.timeline.soundSourcePillRecording" : "editor.timeline.soundSourcePillVideo")

  return (
    <Popover open={open} onOpenChange={setOpenState}>
      <AppTooltip content={label}>
        <PopoverTrigger
          data-testid={variant === "lane" ? "tl-sound-source-picker" : "video-sound-source-picker"}
          data-sound-source={value}
          aria-label={label}
          className={cn(
            variant === "lane"
              ? cn(
                  "inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-md border border-border bg-background font-medium text-foreground/80",
                  "transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  compact ? "h-5 pl-1 pr-0.5 text-[10px]" : "h-6 pl-1.5 pr-1 text-[11px]",
                )
              : cn(
                  "flex h-7 items-center gap-1 whitespace-nowrap rounded-md bg-black/55 pl-2 pr-1.5 text-xs font-medium text-white/80 backdrop-blur-sm",
                  "transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/60",
                ),
          )}
        >
          <span data-testid="video-sound-source-pill">{pill}</span>
          <ChevronDown className={cn("shrink-0", variant === "lane" ? "size-3" : "size-3.5")} aria-hidden />
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent
        align={variant === "lane" ? "start" : "end"}
        side={variant === "lane" ? "bottom" : "top"}
        // As wide as the recording's name needs, up to the window: a fixed
        // 16rem cut even "recording.wav" off (walk r3, 2026-10-05). A name
        // longer than that wraps rather than ending in an ellipsis.
        className="w-max min-w-56 max-w-[min(26rem,calc(100vw-2rem))] p-1"
        data-testid="video-sound-source-menu"
      >
        <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          {t("editor.timeline.soundSourceHeading")}
        </p>
        <div role="radiogroup" aria-label={t("editor.timeline.soundSourceHeading")}>
          {options.map((option) => {
            const checked = option.source === value
            return (
              <button
                key={option.source}
                type="button"
                role="radio"
                aria-checked={checked}
                data-testid={`video-sound-source-${option.source}`}
                onClick={() => {
                  setOpenState(false)
                  if (!checked) onChange(option.source)
                }}
                title={option.label}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                  "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none",
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {checked && <Check className="size-4" aria-hidden />}
                </span>
                <span data-testid={`video-sound-source-${option.source}-label`}
                  className={cn("min-w-0 flex-1 [overflow-wrap:anywhere]", checked && "font-medium")}>
                  {option.label}
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
