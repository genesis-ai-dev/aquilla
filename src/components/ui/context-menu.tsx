import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"

import { cn } from "@/lib/utils"
import {
  POPUP_BASE,
  MenuCheckboxItem,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from "@/components/ui/menu-parts"

type ContextMenuOpenChange = NonNullable<ContextMenuPrimitive.Root.Props["onOpenChange"]>
type ContextMenuOpenChangeDetails = Parameters<ContextMenuOpenChange>[1]

/**
 * Right-clicking elsewhere while a menu is open reads as one menu moving to the
 * new spot, so the close/open pair must not cross-dissolve. Base UI only sets
 * `data-instant` itself for keyboard presses, dismissals, and menubar moves, so
 * the roots coordinate the reposition here.
 *
 * The outgoing root is dismissed on `pointerdown`, before the `contextmenu`
 * event reaches the next trigger — the two roots never see each other open, so
 * this is a short window rather than a count of open roots.
 */
const REPOSITION_WINDOW_MS = 250

/** Base UI's own `data-instant` value for "the menu moved to another trigger". */
const INSTANT_TRIGGER_CHANGE = "trigger-change"

let repositionedAt = Number.NEGATIVE_INFINITY

/** A right-press outside the popup is the start of a reposition, not a dismiss. */
function isRepositionDismissal(details: ContextMenuOpenChangeDetails) {
  if (details.reason !== "outside-press") {
    return false
  }
  const event = details.event
  if (!("button" in event)) {
    return false
  }
  // macOS opens the menu on ctrl + primary press as well as secondary press.
  return event.button === 2 || (event.button === 0 && event.ctrlKey)
}

const ContextMenuInstantContext = React.createContext<string | undefined>(undefined)

function ContextMenu({ onOpenChange, ...props }: ContextMenuPrimitive.Root.Props) {
  const [instant, setInstant] = React.useState<string | undefined>(undefined)

  const handleOpenChange: ContextMenuOpenChange = (open, details) => {
    if (open) {
      setInstant(
        Date.now() - repositionedAt < REPOSITION_WINDOW_MS
          ? INSTANT_TRIGGER_CHANGE
          : undefined,
      )
    } else if (isRepositionDismissal(details)) {
      repositionedAt = Date.now()
      setInstant(INSTANT_TRIGGER_CHANGE)
    } else {
      // Deliberate closes (escape, item press, plain outside click) keep their
      // exit, including on a menu that was opened instantly.
      setInstant(undefined)
    }
    onOpenChange?.(open, details)
  }

  return (
    <ContextMenuInstantContext.Provider value={instant}>
      <ContextMenuPrimitive.Root
        data-slot="context-menu"
        onOpenChange={handleOpenChange}
        {...props}
      />
    </ContextMenuInstantContext.Provider>
  )
}

function ContextMenuPortal({ ...props }: ContextMenuPrimitive.Portal.Props) {
  return (
    <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
  )
}

function ContextMenuTrigger({
  className,
  ...props
}: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      className={cn("select-none", className)}
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  align = "start",
  alignOffset = 4,
  side = "right",
  sideOffset = 0,
  ...props
}: ContextMenuPrimitive.Popup.Props &
  Pick<
    ContextMenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const instant = React.useContext(ContextMenuInstantContext)

  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          // Only override Base UI's own value when this root repositioned.
          {...(instant ? { "data-instant": instant } : null)}
          // Matched on the value, not on the bare attribute: Base UI reports
          // `data-instant="click"` for every mouse-driven context menu (a
          // `contextmenu` event has `detail === 0`, which its keyboard-press
          // heuristic reads as a keyboard press), so a bare `data-instant`
          // selector would delete every entrance. `animate-none!` beats the
          // enter/exit utilities regardless of the order Tailwind emits them in.
          className={cn(
            POPUP_BASE,
            "min-w-36 data-[instant=trigger-change]:animate-none!",
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuPortal,
  // Shared with the dropdown menu — see `menu-parts.tsx`.
  MenuSub as ContextMenuSub,
  MenuSubContent as ContextMenuSubContent,
  MenuCheckboxItem as ContextMenuCheckboxItem,
  MenuGroup as ContextMenuGroup,
  MenuItem as ContextMenuItem,
  MenuLabel as ContextMenuLabel,
  MenuRadioGroup as ContextMenuRadioGroup,
  MenuRadioItem as ContextMenuRadioItem,
  MenuSeparator as ContextMenuSeparator,
  MenuShortcut as ContextMenuShortcut,
  MenuSubTrigger as ContextMenuSubTrigger,
}
