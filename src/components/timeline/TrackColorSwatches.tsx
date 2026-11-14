// The six track colours as swatches, three across. (Sam, 2026-09-28)
//
// Used by both colour pickers — the timeline's track menu and the Audio view's
// dot — inside the caller's radio group, whose value is the RESOLVED hex (see
// each caller). No names on screen, so nothing to translate there; each swatch
// keeps its colour's name as its accessible name, and the menu's own radio
// items supply the arrow keys, Enter and the checked state.
//
// AQU-2235: each swatch is the colour its track will then SHOW — the strip at
// the track's far left, its dot and its name bar (chroma 0.14 at the colour's
// own lightness) — drawn from the same variables, not the raw palette hex.

import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { useT } from "@/lib/i18n/I18nProvider"
import { TRACK_DOT_CLASS, TRACK_HUES, trackHueVars } from "@/lib/timeline/track-colors"
import { cn } from "@/lib/utils"

export function TrackColorSwatches({ onPick }: { onPick: (hueId: string) => void }) {
  const t = useT()
  return (
    <div data-testid="track-color-swatches" className="grid grid-cols-3 gap-0.5">
      {TRACK_HUES.map((hue) => (
        <MenuPrimitive.RadioItem
          key={hue.id}
          value={hue.hex}
          aria-label={t(hue.labelKey as Parameters<typeof t>[0])}
          onClick={() => onPick(hue.id)}
          className="group/swatch grid size-6 place-items-center rounded-md outline-none data-highlighted:bg-accent"
        >
          <span
            aria-hidden
            className={cn(
              "size-3.5 rounded-full ring-1 ring-foreground/15 group-data-checked/swatch:ring-2 group-data-checked/swatch:ring-foreground/70 group-data-checked/swatch:ring-offset-1 group-data-checked/swatch:ring-offset-popover",
              TRACK_DOT_CLASS,
            )}
            style={trackHueVars(hue.id)}
          />
        </MenuPrimitive.RadioItem>
      ))}
    </div>
  )
}
