// The small controls every media panel carries. (Media redesign, layout —
// canvas board 23, "Lean chrome: your mix", Oct 24.)
//
// Each area has a 24 px strip: its panels as tabs on the left, and on the
// right, always visible, Full screen (or Restore), Fold, and ⋯. The timeline
// has no strip — no title row at all — and carries the same three controls in
// its corner cell, beside "Tracks", above the track names.
//
// No chevrons and no rails: a folded panel leaves nothing behind, and the
// Panels button above the view is the way back.

import { useEffect, useRef, useState, type ReactNode } from "react"
import { Expand, FileText, Film, Minus, MoreHorizontal, Shrink } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { isApplePlatform } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { DOCK_AREAS, type DockArea, type DockPanel, type DockRegion, type DockView } from "./media-dock-layout"
import type { MediaDock } from "./useMediaDock"

/** The keys, as this machine writes them. */
export function dockKeys() {
  const mac = isApplePlatform()
  return {
    panels: mac ? "⌘\\" : "Ctrl+\\",
    full: mac ? "⌘⇧F" : "Ctrl+Shift+F",
    fold: mac ? "⌘⇧H" : "Ctrl+Shift+H",
    restore: "Esc",
    show: (n: number) => (mac ? `⌥${n}` : `Alt+${n}`),
  }
}

export const PANEL_ICON: Record<DockPanel, typeof Film> = { film: Film, text: FileText }

/** "Film" / "Text", and the areas' names. */
export function usePanelNames() {
  const t = useT()
  return {
    panel: (p: DockPanel | "timeline") =>
      p === "timeline" ? t("editor.timeline.title") : p === "film" ? t("editor.dock.film") : t("editor.timeline.textPaneTitle"),
    area: (a: DockArea) => (a === "ll" ? t("editor.dock.bottomLeft") : t("editor.dock.bottomRight")),
  }
}

/** What a region's controls need: the workspace's dock, narrowed to one region. */
export interface RegionLayoutControls {
  /** This region has the whole view: the button reads Restore. */
  isFull: boolean
  /** Something else is still open, so folding this cannot empty the view. */
  canFold: boolean
  onToggleFull(): void
  onFold(): void
}

export function regionControls(dock: MediaDock, region: DockRegion): RegionLayoutControls {
  return {
    isFull: dock.fullRegion === region,
    canFold: dock.view.canFold(region),
    onToggleFull: () => dock.toggleFull(region),
    onFold: () => dock.fold(region),
  }
}

const ICON_BTN = "text-muted-foreground hover:text-foreground"
/** The corner squares' look, for the timeline corner's other buttons (its +). */
export const CORNER_ICON_BTN = ICON_BTN

/**
 * Full screen (or Restore), Fold, and the ⋯ the caller builds — in that order,
 * 24 px each with 14 px icons. Fold is withheld while this is the only thing
 * open: there would be nothing left on screen.
 */
export function PanelControlButtons({
  region,
  controls,
  menu,
  foldTip,
  compact = false,
  leading,
}: {
  region: DockRegion
  controls: RegionLayoutControls
  menu: ReactNode
  /** The timeline says "Fold the timeline"; an area, "Fold this area". */
  foldTip: string
  /** Room for two squares only (the narrow track names): Fold stays in the ⋯. */
  compact?: boolean
  /** Before Full screen: the timeline corner's + (Add track, board 55). */
  leading?: ReactNode
}) {
  const t = useT()
  const keys = dockKeys()
  const fullTip = controls.isFull
    ? t("editor.dock.restoreTip", { keys: keys.restore })
    : t("editor.dock.fullScreenTip", { keys: keys.full })
  return (
    <div className="ms-auto flex shrink-0 items-center gap-px" data-testid={`dock-controls-${region}`}>
      {leading}
      <AppTooltip content={fullTip}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={ICON_BTN}
          aria-label={fullTip}
          aria-pressed={controls.isFull}
          data-testid={`dock-full-${region}`}
          onClick={controls.onToggleFull}
        >
          {controls.isFull ? <Shrink className="size-3.5" /> : <Expand className="size-3.5" />}
        </Button>
      </AppTooltip>
      {controls.canFold && !compact && (
        <AppTooltip content={foldTip}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={ICON_BTN}
            aria-label={foldTip}
            data-testid={`dock-fold-${region}`}
            onClick={controls.onFold}
          >
            <Minus className="size-3.5" />
          </Button>
        </AppTooltip>
      )}
      {menu}
    </div>
  )
}

/** The ⋯ trigger, the same 24 px square as its neighbours. */
function MoreTrigger({ tip, testId }: { tip: string; testId: string }) {
  return (
    <AppTooltip content={tip}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={ICON_BTN}
            aria-label={tip}
            data-testid={testId}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        }
      />
    </AppTooltip>
  )
}

/** The layout icon's geometry, in a 24 × 24 box like a lucide icon's. */
export interface LayoutGlyphShape {
  /** The destination, drawn solid: [x, y, w, h]. */
  target: [number, number, number, number]
  /** The timeline's band is drawn (it is folded otherwise). */
  timelineBand: boolean
  /** The line between bottom left and bottom right, when both are drawn. */
  split: number | null
  /** Where the areas start: under the band, or the frame's top. */
  top: number
}

const FRAME = { x: 2, y: 4, w: 20, h: 16 }

/**
 * The media view as a simple map (Sam, Oct 27: "one frame, the target solid").
 * One rounded frame; the timeline as a band across its top unless folded; the
 * areas below in their real arrangement, side by side; the area the panel
 * would move to filled. Areas that don't exist (no panel, or folded) aren't
 * drawn, except the destination, since moving there opens it. The app has no
 * right side area yet, so the map has none either.
 */
export function layoutGlyphShape(view: DockView, target: DockArea): LayoutGlyphShape {
  const band = view.isOpen("tl")
  const top = band ? 10 : FRAME.y
  const bottom = FRAME.y + FRAME.h
  const left = FRAME.x
  const right = FRAME.x + FRAME.w
  const drawn = DOCK_AREAS.filter((a) => view.isOpen(a) || a === target)
  const mid = (left + right) / 2
  const both = drawn.length > 1
  const cell = (a: DockArea): [number, number, number, number] =>
    !both ? [left, top, right - left, bottom - top] : a === "ll" ? [left, top, mid - left, bottom - top] : [mid, top, right - mid, bottom - top]
  return { target: cell(target), timelineBand: band, split: both ? mid : null, top }
}

/** The icon on "Move to …": the layout as a map, the destination solid.
 *  Drawn in the menu's own icon colour, so it sits beside the others. */
export function MediaLayoutGlyph({ view, target }: { view: DockView; target: DockArea }) {
  const g = layoutGlyphShape(view, target)
  const [x, y, w, h] = g.target
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="layout-glyph"
    >
      <rect data-part="target" x={x} y={y} width={w} height={h} fill="currentColor" stroke="none" />
      <rect data-part="frame" x={FRAME.x} y={FRAME.y} width={FRAME.w} height={FRAME.h} rx={2} />
      {g.timelineBand && <line data-part="timeline" x1={FRAME.x} y1={10} x2={FRAME.x + FRAME.w} y2={10} />}
      {g.split !== null && <line data-part="split" x1={g.split} y1={g.top} x2={g.split} y2={FRAME.y + FRAME.h} />}
    </svg>
  )
}

/**
 * An area's ⋯: where the panel is, Move to the other area, and the note that
 * a tab can also be dragged or double-clicked. Full screen and Fold are the
 * buttons beside it, so the menu leaves them out, as the timeline's does
 * (Sam, Oct 27; the Film and Text panels followed Oct 29).
 */
export function AreaMenu({ dock, area }: { dock: MediaDock; area: DockArea }) {
  const t = useT()
  const names = usePanelNames()
  const panel = dock.view.activeOf(area)
  if (!panel) return null
  const other: DockArea = area === "ll" ? "lr" : "ll"
  return (
    <DropdownMenu>
      <MoreTrigger tip={t("editor.dock.moreTip")} testId={`dock-more-${area}`} />
      <DropdownMenuContent align="end" className="w-[270px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wide">
            {t(area === "ll" ? "editor.dock.menuHeadingBottomLeft" : "editor.dock.menuHeadingBottomRight", { panel: names.panel(panel) })}
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => dock.move(panel, other)} data-testid={`dock-move-${area}`}>
            <MediaLayoutGlyph view={dock.view} target={other} />
            {t(other === "ll" ? "editor.dock.moveToBottomLeft" : "editor.dock.moveToBottomRight")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <p className="px-1.5 py-1 text-xs leading-snug text-muted-foreground">{t("editor.dock.dragNote")}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The timeline's ⋯ (Decided › LAYOUT: "timeline ⋯, no Move" — it is the
 * anchor everything else docks to): its heading, then the timeline's own
 * settings, which the 40 px bar has no room for. Full screen and Fold are the
 * buttons beside it, so the menu leaves them out (Sam, Oct 27) — except Fold
 * while the track names are narrowed, when there is room for Full screen and
 * this ⋯ only.
 */
export function TimelineMenu({
  controls,
  compact = false,
  settings,
}: {
  controls?: RegionLayoutControls
  compact?: boolean
  settings?: ReactNode
}) {
  const t = useT()
  const keys = dockKeys()
  return (
    <DropdownMenu>
      <MoreTrigger tip={t("editor.dock.timelineMoreTip")} testId="dock-more-tl" />
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wide">{t("editor.timeline.title")}</DropdownMenuLabel>
          {compact && controls?.canFold && (
            <DropdownMenuItem onClick={controls.onFold} data-testid="dock-menu-fold-tl">
              <Minus />
              {t("editor.dock.foldTimeline")}
              <DropdownMenuShortcut>{keys.fold}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        {settings}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const DRAG_TYPE = "application/x-aquilla-panel"

/**
 * An area's strip: its panels as tabs, then the three controls. A tab shows its
 * panel on a click, takes the whole view on a double-click, and moves to the
 * other area when dragged there.
 */
export function MediaAreaStrip({ dock, area }: { dock: MediaDock; area: DockArea }) {
  const t = useT()
  const names = usePanelNames()
  const keys = dockKeys()
  const tabs = dock.view.list(area)
  const active = dock.view.activeOf(area)
  return (
    <div
      data-testid={`dock-strip-${area}`}
      className="flex h-6 shrink-0 items-center gap-1 border-b border-border bg-muted/30 ps-1.5 pe-1"
    >
      <Tabs value={active} onValueChange={(v) => dock.activate(v as DockPanel)}>
        <TabsList className="h-5 gap-0.5 bg-transparent p-0">
          {tabs.map((panel) => {
            const Icon = PANEL_ICON[panel]
            const n = panel === "film" ? 2 : 3
            return (
              <AppTooltip key={panel} content={t("editor.dock.tabTip", { panel: names.panel(panel), keys: keys.show(n) })}>
                <TabsTrigger
                  value={panel}
                  data-testid={`dock-tab-${panel}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, panel)
                    e.dataTransfer.effectAllowed = "move"
                  }}
                  onDoubleClick={() => dock.toggleFull(area)}
                  className="h-5 gap-1 rounded-[5px] px-1.5 py-0 text-[11.5px] font-semibold data-active:shadow-sm data-active:ring-1 data-active:ring-border [&_svg:not([class*='size-'])]:size-3.5"
                >
                  <Icon />
                  {names.panel(panel)}
                </TabsTrigger>
              </AppTooltip>
            )
          })}
        </TabsList>
      </Tabs>
      <PanelControlButtons
        region={area}
        controls={regionControls(dock, area)}
        menu={<AreaMenu dock={dock} area={area} />}
        foldTip={t("editor.dock.foldAreaTip", { keys: keys.fold })}
      />
    </div>
  )
}

/**
 * The drop side of a tab drag: the whole area, outlined while a tab is over it.
 *
 * NATIVE LISTENERS, NOT React props, and that is forced: the film and the text
 * render through portals, and React bubbles a portal's events through the
 * React tree — to where the portal was called, in the workspace — never
 * through the area's DOM box they physically sit in. A drag over the text
 * would never reach an `onDragOver` here.
 */
export function useAreaDrop(dock: MediaDock, area: DockArea) {
  const [over, setOver] = useState(false)
  const [el, setEl] = useState<HTMLElement | null>(null)
  const move = useRef(dock.move)
  move.current = dock.move
  useEffect(() => {
    if (!el) return
    const carries = (e: DragEvent) => Boolean(e.dataTransfer && Array.from(e.dataTransfer.types).includes(DRAG_TYPE))
    const onOver = (e: DragEvent) => {
      if (!carries(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = "move"
      setOver(true)
    }
    const onLeave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) setOver(false)
    }
    const onDrop = (e: DragEvent) => {
      setOver(false)
      const panel = e.dataTransfer?.getData(DRAG_TYPE)
      if (panel !== "film" && panel !== "text") return
      e.preventDefault()
      move.current(panel, area)
    }
    el.addEventListener("dragover", onOver)
    el.addEventListener("dragleave", onLeave)
    el.addEventListener("drop", onDrop)
    return () => {
      el.removeEventListener("dragover", onOver)
      el.removeEventListener("dragleave", onLeave)
      el.removeEventListener("drop", onDrop)
    }
  }, [el, area])
  return { ref: setEl, className: cn(over && "ring-2 ring-inset ring-sky-500/60") }
}
