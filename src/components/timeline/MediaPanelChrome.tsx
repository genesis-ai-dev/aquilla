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
import { ArrowRightLeft, Expand, FileText, Film, Minus, MoreHorizontal, Shrink } from "lucide-react"
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
import type { DockArea, DockPanel, DockRegion } from "./media-dock-layout"
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
}: {
  region: DockRegion
  controls: RegionLayoutControls
  menu: ReactNode
  /** The timeline says "Fold the timeline"; an area, "Fold this area". */
  foldTip: string
  /** Room for two squares only (the narrow track names): Fold stays in the ⋯. */
  compact?: boolean
}) {
  const t = useT()
  const keys = dockKeys()
  const fullTip = controls.isFull
    ? t("editor.dock.restoreTip", { keys: keys.restore })
    : t("editor.dock.fullScreenTip", { keys: keys.full })
  return (
    <div className="ms-auto flex shrink-0 items-center gap-px" data-testid={`dock-controls-${region}`}>
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

/** The full-screen and fold items both menus share. */
function LayoutItems({ controls, foldLabel, region }: { controls: RegionLayoutControls; foldLabel: string; region: DockRegion }) {
  const t = useT()
  const keys = dockKeys()
  return (
    <>
      <DropdownMenuItem onClick={controls.onToggleFull} data-testid={`dock-menu-full-${region}`}>
        {controls.isFull ? <Shrink /> : <Expand />}
        {controls.isFull ? t("editor.dock.restore") : t("editor.dock.fullScreen")}
        <DropdownMenuShortcut>{controls.isFull ? keys.restore : keys.full}</DropdownMenuShortcut>
      </DropdownMenuItem>
      {controls.canFold && (
        <DropdownMenuItem onClick={controls.onFold} data-testid={`dock-menu-fold-${region}`}>
          <Minus />
          {foldLabel}
          <DropdownMenuShortcut>{keys.fold}</DropdownMenuShortcut>
        </DropdownMenuItem>
      )}
    </>
  )
}

/**
 * An area's ⋯: where the panel is, Move to the other area, Full screen, Fold,
 * and the note that a tab can also be dragged or double-clicked.
 */
export function AreaMenu({ dock, area }: { dock: MediaDock; area: DockArea }) {
  const t = useT()
  const names = usePanelNames()
  const panel = dock.view.activeOf(area)
  if (!panel) return null
  const other: DockArea = area === "ll" ? "lr" : "ll"
  const controls = regionControls(dock, area)
  return (
    <DropdownMenu>
      <MoreTrigger tip={t("editor.dock.moreTip")} testId={`dock-more-${area}`} />
      <DropdownMenuContent align="end" className="w-[270px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wide">
            {t("editor.dock.menuHeading", { panel: names.panel(panel), area: names.area(area) })}
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => dock.move(panel, other)} data-testid={`dock-move-${area}`}>
            <ArrowRightLeft />
            {t("editor.dock.moveTo", { area: names.area(other) })}
          </DropdownMenuItem>
          <LayoutItems controls={controls} foldLabel={t("editor.dock.foldArea")} region={area} />
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <p className="px-1.5 py-1 text-xs leading-snug text-muted-foreground">{t("editor.dock.dragNote")}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The timeline's ⋯ (Decided › LAYOUT: "timeline ⋯, no Move" — it is the
 * anchor everything else docks to): Full screen, Fold the timeline, and the
 * timeline's own settings, which the 40 px bar has no room for.
 */
export function TimelineMenu({ controls, settings }: { controls?: RegionLayoutControls; settings?: ReactNode }) {
  const t = useT()
  return (
    <DropdownMenu>
      <MoreTrigger tip={t("editor.dock.timelineMoreTip")} testId="dock-more-tl" />
      <DropdownMenuContent align="start" className="w-[270px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wide">{t("editor.timeline.title")}</DropdownMenuLabel>
          {controls && <LayoutItems controls={controls} foldLabel={t("editor.dock.foldTimeline")} region="tl" />}
        </DropdownMenuGroup>
        {settings && (
          <>
            {controls && <DropdownMenuSeparator />}
            {settings}
          </>
        )}
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
