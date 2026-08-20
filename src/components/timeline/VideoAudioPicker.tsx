// What language the film speaks, chosen from the corner of the picture.
// (AQU-646, 2026-08-18)
//
// The client's masters carry sixty-five dubs of the same episode. Sam: "all of
// these videos technically exist in a whole lot of different languages… I'm
// pretty sure the teams are going to be primarily working from English but
// that's not necessarily going to be the case."
//
// A GLOBE RATHER THAN THE LANGUAGE NAME (Sam's call). The other two overlay
// controls are segmented tabs across the top, but this corner is where the
// burned-in caption's longest lines run, and a control wide enough to read
// "Portuguese (Brazil)" would sit on top of the words. An icon meets them
// rarely, and the caption ignores clicks, so nothing is ever blocked — only
// briefly overlapped.
//
// Sixty-five entries is also too many for tabs, and too many to scroll: the
// menu opens on a search box, so finding Tagalog is typing three letters.

import { useState } from "react"
import { Globe } from "lucide-react"

import { AppTooltip } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { FilmAudioTrack } from "@/lib/video/film-audio-tracks"

export interface VideoAudioPickerProps {
  /** The renditions on offer, narration tracks already excluded. */
  tracks: FilmAudioTrack[]
  /** What is sounding now, as the player resolved it. */
  activeLang: string | null
  onChange(lang: string): void
  /** The corner controls fade out when the pointer leaves the picture. An open
   *  menu has to outlive that, or choosing a language means chasing the list. */
  onOpenChange?(open: boolean): void
}

export function VideoAudioPicker({ tracks, activeLang, onChange, onOpenChange }: VideoAudioPickerProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const setOpenState = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }

  // A film with one soundtrack has nothing to choose, and a control that opens
  // onto a single item is worse than no control. Plain files land here too.
  if (tracks.length < 2) return null

  const active = tracks.find((t) => (t.lang ?? "") === (activeLang ?? ""))
  const label = active ? `Film audio: ${active.name}` : "Film audio"

  return (
    <Popover open={open} onOpenChange={setOpenState}>
      <AppTooltip content={label}>
        <PopoverTrigger
          data-testid="video-audio-picker"
          aria-label={label}
          className={cn(
            // Matches the two caption controls' look: dark, translucent, legible
            // over any frame.
            "flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white/70 backdrop-blur-sm",
            "transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/60",
          )}
        >
          <Globe className="size-4" />
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent
        align="end"
        side="top"
        className="w-64 p-0"
        data-testid="video-audio-picker-menu"
      >
        <Command>
          <CommandInput placeholder={t("editor.timeline.audioTrackSearchPlaceholder")} aria-label={t("editor.timeline.audioTrackSearchAria")} />
          <CommandList>
            <CommandEmpty>{t("editor.timeline.audioTrackNoMatch")}</CommandEmpty>
            <CommandGroup heading={t("editor.timeline.audioTrackFilmAudio")}>
              {tracks.map((track) => {
                const lang = track.lang ?? ""
                const isActive = track === active
                return (
                  <CommandItem
                    key={`${track.id}:${lang}`}
                    // cmdk filters on this, so BOTH the name and the code are
                    // searchable: someone who knows the film is "pt-BR" should
                    // not have to remember how we spell Portuguese.
                    value={`${track.name} ${lang}`}
                    onSelect={() => {
                      setOpenState(false)
                      if (lang) onChange(lang)
                    }}
                    data-active={isActive || undefined}
                  >
                    <span className={cn("flex-1 truncate", isActive && "font-medium")}>
                      {track.name}
                    </span>
                    {isActive && <span aria-hidden className="text-xs text-muted-foreground">✓</span>}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
