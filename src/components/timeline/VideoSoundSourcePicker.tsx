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
// and has the same look, for the same reasons: an icon keeps clear of the
// burned-in caption, and the corner controls fade with the pointer.

import { useState } from "react"
import { Check, Volume2 } from "lucide-react"

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
}

export function VideoSoundSourcePicker({ value, recordingName, onChange, onOpenChange }: VideoSoundSourcePickerProps) {
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

  return (
    <Popover open={open} onOpenChange={setOpenState}>
      <AppTooltip content={label}>
        <PopoverTrigger
          data-testid="video-sound-source-picker"
          data-sound-source={value}
          aria-label={label}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white/70 backdrop-blur-sm",
            "transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/60",
          )}
        >
          <Volume2 className="size-4" />
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent
        align="end"
        side="top"
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
