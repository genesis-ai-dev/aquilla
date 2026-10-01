// The Audio view's colour picker. (Sam, 2026-09-26)
//
// Audio mode has no timeline, so no track name to right-click — but its takes
// now wear the file's dub-track colour, and the heading over the column they
// sit in is the nearest thing it has to one. A dot beside that heading shows
// the colour; a maintainer presses it to pick one of the same six swatches the
// timeline offers.
//
// It is the SAME stored value as the timeline's (the file's `target-audio`
// track colour, in files.meta.trackOverrides): a file seen in both views shows
// one colour, and everyone on the project sees the one that was picked. The
// caller withholds the whole control from anyone who cannot change it — the
// cards below already say what the colour is.
//
// The swatches are just swatches, three across (Sam, 2026-09-28) — the same
// grid as the timeline's track menu (TrackColorSwatches).

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useT } from "@/lib/i18n/I18nProvider"
import { TRACK_HUES, parseTrackHue } from "@/lib/timeline/track-colors"
import { TrackColorSwatches } from "@/components/timeline/TrackColorSwatches"

export function AudioTrackColorPicker({
  color,
  onPick,
}: {
  /** The stored colour token; null or absent is the default green. */
  color: string | null | undefined
  /** Writes the hue's ID, never its hex — as the timeline does. */
  onPick: (hueId: string) => void
}) {
  const t = useT()
  const current = parseTrackHue(color)
  const currentName = TRACK_HUES.find((h) => h.hex === current)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="audio-track-color"
        aria-label={t("editor.audioLens.trackColorAria", {
          color: currentName ? t(currentName.labelKey as Parameters<typeof t>[0]) : current,
        })}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted"
      >
        <span
          aria-hidden
          data-testid="audio-track-color-dot"
          className="h-3 w-3 rounded-full ring-1 ring-foreground/15"
          style={{ backgroundColor: current }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-0 p-1.5">
        {/* Keyed by the RESOLVED hex, as the timeline's submenu is, so a file
            nobody has coloured announces Green — which is what it is drawn in.
            The heading sits inside the group it names. */}
        <DropdownMenuRadioGroup value={current}>
          <DropdownMenuLabel className="px-1 pb-1.5 pt-0.5 text-xs font-normal text-muted-foreground">
            {t("editor.audioLens.trackColorLabel")}
          </DropdownMenuLabel>
          <TrackColorSwatches onPick={onPick} />
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
