// The Panels menu above the media lens. (Media redesign, layout — Sam, Oct 24.)
//
// Folded panels take no room any more, so something has to bring them back:
// this lists the lens's panels with a tick beside each one on screen, and
// choosing one shows or hides it. It is the app's ordinary OverflowMenu with a
// label, the same dress as the timeline's Sources menu, so it reads as part of
// the toolbar rather than as new chrome. Reset layout sits at the bottom,
// as it does in the timeline's ⋯ menu.

import { LayoutGrid, RotateCcw } from "lucide-react"
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MediaSectionId } from "./media-section-layout"

export interface MediaPanelsMenuProps {
  /** The panels this file has, top to bottom then left to right. */
  present: readonly MediaSectionId[]
  /** On screen right now — not folded, and not inside a folded body row. */
  isVisible: (id: MediaSectionId) => boolean
  /** May this panel be hidden? (The text can't be, on a file with no video.) */
  canCollapse: (id: MediaSectionId) => boolean
  collapse: (id: MediaSectionId) => void
  expand: (id: MediaSectionId) => void
  resetLayout: () => void
  className?: string
}

const LABEL_KEY = {
  timeline: "editor.timeline.title",
  video: "editor.timeline.videoPaneTitle",
  text: "editor.timeline.textPaneTitle",
} as const

export function MediaPanelsMenu({
  present,
  isVisible,
  canCollapse,
  collapse,
  expand,
  resetLayout,
  className,
}: MediaPanelsMenuProps) {
  const t = useT()
  const items: OverflowMenuItem[] = [
    ...present.map((id): OverflowMenuItem => {
      const visible = isVisible(id)
      // A shown panel that cannot be hidden is greyed out with its reason; a
      // hidden one can always come back.
      const locked = visible && !canCollapse(id)
      return {
        id: `panel-${id}`,
        type: "checkbox",
        label: t(LABEL_KEY[id]),
        checked: visible,
        disabled: locked,
        disabledReason: locked && id === "text" ? t("editor.timeline.panelsTextOnlyReason") : undefined,
        testId: `media-panels-${id}`,
        onCheckedChange: (checked) => (checked ? expand(id) : collapse(id)),
      }
    }),
    { id: "panels-separator", type: "separator" },
    {
      id: "panels-reset",
      label: t("editor.timeline.resetLayout"),
      icon: RotateCcw,
      testId: "media-panels-reset",
      onClick: resetLayout,
    },
  ]
  return (
    <OverflowMenu
      items={items}
      triggerLabel={t("editor.timeline.panelsMenu")}
      triggerIcon={LayoutGrid}
      triggerVariant="outline"
      triggerSize="sm"
      triggerClassName={className}
      testId="media-panels-menu"
    />
  )
}
