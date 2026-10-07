// The six track colours as swatches, three across. (Sam, 2026-09-28)
//
// Used by both colour pickers — the timeline's track menu and the Audio view's
// dot — inside the caller's radio group, whose value is the RESOLVED hex (see
// each caller). No names on screen, so nothing to translate there; each swatch
// keeps its colour's name as its accessible name, and the menu's own radio
// items supply the arrow keys, Enter and the checked state.

import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { useT } from "@/lib/i18n/I18nProvider"
import { TRACK_HUES } from "@/lib/timeline/track-colors"

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
          className="group/swatch grid size-6 cursor-pointer place-items-center rounded-md outline-none data-highlighted:bg-accent"
        >
          <span
            aria-hidden
            className="size-3.5 rounded-full ring-1 ring-foreground/15 group-data-checked/swatch:ring-2 group-data-checked/swatch:ring-foreground/70 group-data-checked/swatch:ring-offset-1 group-data-checked/swatch:ring-offset-popover"
            style={{ backgroundColor: hue.hex }}
          />
        </MenuPrimitive.RadioItem>
      ))}
    </div>
  )
}
