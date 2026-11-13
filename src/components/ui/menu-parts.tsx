import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"
import { ChevronRightIcon, CheckIcon } from "lucide-react"

/**
 * The parts a dropdown menu and a context menu hold in common.
 *
 * In Base UI these really are one component: `ContextMenu` re-exports the menu
 * parts, so only `Root` and `Trigger` differ between the two. Everything below
 * therefore has a single implementation, and `context-menu.tsx` /
 * `dropdown-menu.tsx` re-export it under their own names with their own
 * `data-slot` values.
 *
 * Use these neutral names directly for a menu that is rendered under both a
 * context-menu root and a dropdown root — a table row's ⋯ menu, for instance.
 */

/**
 * Connects a menu root to a trigger that cannot sit inside it. A trigger takes
 * the nearest root otherwise — which is the context menu, not the button's own
 * menu, when the trigger lives inside a context-menu trigger. Pass it to both.
 */
const createMenuHandle = MenuPrimitive.createHandle

/** One group name for every item, so `MenuShortcut` can key off item focus. */
const ITEM_BASE =
  "group/menu-item relative flex cursor-default items-center gap-1.5 rounded-md text-sm outline-hidden select-none focus:bg-accent/40 focus:text-accent-foreground data-inset:ps-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

const ITEM_DESTRUCTIVE =
  "not-data-[variant=destructive]:focus:**:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:*:[svg]:text-destructive"

/** Indicator items reserve room on the end side for the check mark. */
const INDICATOR_ITEM_BASE = "py-1 pe-8 ps-1.5 focus:**:text-accent-foreground"

const INDICATOR_SLOT =
  "pointer-events-none absolute end-2 flex items-center justify-center"

function MenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(ITEM_BASE, "px-1.5 py-1", ITEM_DESTRUCTIVE, className)}
      {...props}
    />
  )
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="menu-checkbox-item"
      data-inset={inset}
      className={cn(ITEM_BASE, INDICATOR_ITEM_BASE, className)}
      checked={checked}
      {...props}
    >
      <span className={INDICATOR_SLOT} data-slot="menu-checkbox-item-indicator">
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  )
}

function MenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />
}

function MenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="menu-radio-item"
      data-inset={inset}
      className={cn(ITEM_BASE, INDICATOR_ITEM_BASE, className)}
      {...props}
    >
      <span className={INDICATOR_SLOT} data-slot="menu-radio-item-indicator">
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

function MenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />
}

function MenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="menu-label"
      data-inset={inset}
      className={cn(
        "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:ps-7",
        className,
      )}
      {...props}
    />
  )
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function MenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="menu-shortcut"
      className={cn(
        "ms-auto text-xs tracking-widest text-muted-foreground group-focus/menu-item:text-accent-foreground",
        className,
      )}
      {...props}
    />
  )
}

type MenuAnchor = NonNullable<MenuPrimitive.Positioner.Props["anchor"]>

/**
 * A rect with the trigger row's height and the whole parent menu's width. A
 * submenu anchored to the row itself opens over the parent's padding; anchored
 * here, it sits against the parent's outer edge on whichever side it lands.
 */
function parentMenuEdge(trigger: HTMLElement) {
  const menu = trigger.closest<HTMLElement>('[role="menu"]') ?? trigger
  return {
    contextElement: trigger,
    getBoundingClientRect() {
      const row = trigger.getBoundingClientRect()
      const edge = menu.getBoundingClientRect()
      return {
        x: edge.left,
        y: row.top,
        left: edge.left,
        right: edge.right,
        top: row.top,
        bottom: row.bottom,
        width: edge.width,
        height: row.height,
      }
    },
  }
}

const SubmenuAnchorContext = React.createContext<{
  setTrigger: (node: HTMLElement | null) => void
  anchor: MenuAnchor
} | null>(null)

function MenuSubTrigger({
  className,
  inset,
  children,
  ref,
  delay = 0,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean
}) {
  const submenu = React.useContext(SubmenuAnchorContext)
  return (
    <MenuPrimitive.SubmenuTrigger
      delay={delay}
      ref={(node: HTMLDivElement | null) => {
        submenu?.setTrigger(node)
        if (typeof ref === "function") ref(node)
        else if (ref) ref.current = node
      }}
      data-slot="menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent/40 focus:text-accent-foreground focus:**:text-accent-foreground data-inset:ps-7 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ms-auto" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

/**
 * Popup chrome shared by every menu surface. Width and root-level positioning
 * stay with each surface's own `Content`, as does the `data-instant` reposition
 * rule that only a context menu can trigger.
 *
 * Open and close are transitions on `data-starting-style` / `data-ending-style`.
 * Base UI paints the starting style for one frame with transitions disabled,
 * then removes it, which is what a transition needs. A keyframe enter
 * (`data-open:animate-in`) never shows: the popup mounts already open, and the
 * registered enter variables resolve to their initial values on that first
 * frame, so only the close — an attribute change on an element already on
 * screen — plays.
 */
const POPUP_SURFACE =
  "z-50 max-h-(--available-height) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"

const POPUP_BASE = cn(
  POPUP_SURFACE,
  "origin-(--transform-origin) transition-[opacity,scale,translate] duration-100 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-[side=bottom]:data-starting-style:-translate-y-2 data-[side=inline-end]:data-starting-style:-translate-x-2 data-[side=inline-start]:data-starting-style:translate-x-2 data-[side=left]:data-starting-style:translate-x-2 data-[side=right]:data-starting-style:-translate-x-2 data-[side=top]:data-starting-style:translate-y-2",
)

function MenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const anchor = React.useMemo(
    () => ({
      setTrigger: (node: HTMLElement | null) => {
        triggerRef.current = node
      },
      anchor: () => (triggerRef.current ? parentMenuEdge(triggerRef.current) : null),
    }),
    [],
  )
  return (
    <SubmenuAnchorContext.Provider value={anchor}>
      <MenuPrimitive.SubmenuRoot data-slot="menu-sub" {...props} />
    </SubmenuAnchorContext.Provider>
  )
}

/**
 * A submenu anchors to its parent menu's edge on every surface, so unlike a
 * root popup it needs no per-surface positioning. It opens and closes without
 * motion: the parent is already on screen, and a submenu that grows out of it
 * reads as lag while the pointer moves down a list of submenu rows.
 */
function MenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const submenu = React.useContext(SubmenuAnchorContext)
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        anchor={submenu?.anchor}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="menu-sub-content"
          className={cn(POPUP_SURFACE, "w-auto min-w-[96px] shadow-lg", className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

export {
  MenuPrimitive,
  POPUP_BASE,
  createMenuHandle,
  parentMenuEdge,
  MenuItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroup,
  MenuLabel,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
}
