// Linking mode's click surface. (AQU-646 stage 4)
//
// An episode ships two cue lists that deliberately disagree — the subtitles
// (what gets translated) and the audio VTT (a transcript of what is heard, and
// what recording follows). The auto-linker pairs them at import and gets the
// large majority right; this is how a person fixes the rest.
//
// A TRANSPARENT OVERLAY RATHER THAN NEW CHIP BEHAVIOUR, and that is the whole
// design. Sam's requirement was that linking mode be an explicit toggle and
// that ordinary clicking stay ordinary when it is off. Threading a "but in this
// mode, click means something else" branch through TimelineCard would put that
// switch inside every lane's click path forever; an overlay that simply is not
// rendered when the mode is off cannot change what a click does. It also means
// seek, drag, trim and selection keep working exactly as they did, because none
// of their code was touched.
//
// Geometry is recomputed here rather than read off the chips: the lanes already
// place chips with `secToPx(span.start)` and the same width, so repeating that
// one expression is cheaper and less fragile than measuring the DOM.

import { secToPx, chipRadiusPx } from "@/lib/timeline/scale"
import { TL_CHIP_BOX_CLASS } from "@/lib/timeline/row-metrics"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"

export interface LinkOverlayItem {
  id: string
  startSec: number
  endSec: number
}

export interface LaneLinkOverlay {
  /** The chip a pairing is being made FROM, on whichever lane it lives. Null
   *  until something is picked. */
  pickedId: string | null
  /** Ids ON THIS LANE currently paired with the picked chip. When nothing is
   *  picked this is empty and the lane just shows its unlinked marks. */
  linkedIds: ReadonlySet<string>
  /** Ids on this lane with no pairing at all — the genuinely unsubtitled
   *  utterances on the audio side, the screen cards on the subtitle side. */
  unlinkedIds: ReadonlySet<string>
  /** Click. On the picked chip's own lane this re-picks; on the other lane it
   *  adds or removes the pairing. The workspace decides which. */
  onPick(id: string): void
}

interface Props extends LaneLinkOverlay {
  items: readonly LinkOverlayItem[]
  pxPerSec: number
}

export function CueLinkOverlay({
  items,
  pxPerSec,
  pickedId,
  linkedIds,
  unlinkedIds,
  onPick,
}: Props) {
  const t = useT()
  return (
    <>
      {items.map((item) => {
        const widthPx = secToPx(item.endSec - item.startSec, pxPerSec)
        const picked = pickedId === item.id
        const linked = linkedIds.has(item.id)
        const unlinked = unlinkedIds.has(item.id)
        return (
          <div
            key={item.id}
            data-testid="tl-link-target"
            data-cell-id={item.id}
            data-link-state={picked ? "picked" : linked ? "linked" : unlinked ? "unlinked" : "idle"}
            role="button"
            tabIndex={0}
            title={
              picked
                ? t("editor.timeline.pairingFromThis")
                : linked
                  ? t("editor.timeline.pairedClickToUnpair")
                  : t("editor.timeline.clickToPair")
            }
            onClick={(e) => {
              // The chip underneath still has its own click handlers; letting
              // this through would seek the transport on every pairing.
              e.stopPropagation()
              onPick(item.id)
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return
              e.preventDefault()
              e.stopPropagation()
              onPick(item.id)
            }}
            className={cn(
              "absolute z-20 cursor-pointer ring-inset transition-colors",
              TL_CHIP_BOX_CLASS,
              picked && "bg-violet-500/25 ring-2 ring-violet-500",
              !picked && linked && "bg-emerald-500/20 ring-2 ring-emerald-500",
              // An unlinked chip is worth seeing even before anything is
              // picked: on episode 101 there are only about ten of them, and
              // they are exactly the lines that need dubbing with no subtitle
              // to read from.
              !picked && !linked && unlinked && "bg-amber-500/10 ring-1 ring-amber-500/60",
              !picked && !linked && !unlinked && "ring-1 ring-transparent hover:ring-violet-400/70",
            )}
            style={{
              left: `${secToPx(item.startSec, pxPerSec)}px`,
              width: `${widthPx}px`,
              borderRadius: `${chipRadiusPx(widthPx)}px`,
            }}
          />
        )
      })}
    </>
  )
}
