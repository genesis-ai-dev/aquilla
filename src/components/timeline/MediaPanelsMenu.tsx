// The Panels button and its menu. (Media redesign, layout — canvas board 23,
// "Lean chrome: your mix", Oct 24.)
//
// A folded panel leaves nothing behind, so this is the way back to every one
// of them: where each panel is, a Show button for each one out of sight, the
// way out of full screen, and Reset layout. ⌘\ opens it from anywhere in the
// media view.

import type { ReactNode } from "react"
import { LayoutGrid, RotateCcw, Shrink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AppTooltip } from "@/components/ui/tooltip"
import { VoiceInfoTip } from "@/components/voice/VoiceInfoTip"
import { useT } from "@/lib/i18n/I18nProvider"
import { undoTargets, type DockPanel } from "./media-dock-layout"
import type { MediaFileKind } from "./media-layout-start"
import { dockKeys, usePanelNames } from "./MediaPanelChrome"
import type { MediaDock } from "./useMediaDock"

const START_KEY = {
  dub: "editor.dock.startDub",
  subtitles: "editor.dock.startSubtitles",
  scripture: "editor.dock.startScripture",
  plain: "editor.dock.startPlain",
} as const

export interface MediaPanelsMenuProps {
  dock: MediaDock
  /** The open file's name, for "your teammates keep their own arrangement of …". */
  fileName: string
  kind: MediaFileKind
  /** A film is linked but Free timing hides it: the Film row says so. */
  filmHiddenByTiming: boolean
  /** Live · Synced and the status line, at the top. */
  status?: ReactNode
}

export function MediaPanelsMenu({ dock, fileName, kind, filmHiddenByTiming, status }: MediaPanelsMenuProps) {
  const t = useT()
  const names = usePanelNames()
  const keys = dockKeys()
  const v = dock.view
  const full = dock.fullRegion

  const stateWords = (parts: Array<string | null | false>) => parts.filter(Boolean).join(" · ")

  const row = (id: "timeline" | DockPanel, n: number) => {
    let where: string
    let showing: boolean
    if (id === "timeline") {
      showing = v.isOpen("tl")
      where = stateWords([
        t("editor.dock.whereTimeline"),
        !showing && t("editor.dock.stateFolded"),
        full === "tl" && t("editor.dock.stateFull"),
      ])
    } else if (id === "film" && filmHiddenByTiming) {
      showing = true
      where = t("editor.dock.filmHiddenByTiming")
    } else {
      const area = v.areaOf(id)!
      const active = v.activeOf(area)
      showing = v.isShowing(id)
      where = stateWords([
        names.area(area),
        !v.isOpen(area)
          ? t("editor.dock.stateFolded")
          : active !== id && active
            ? t("editor.dock.stateBehind", { panel: names.panel(active) })
            : t("editor.dock.stateShowing"),
        full === area && t("editor.dock.stateFull"),
      ])
    }
    return (
      <div key={id} className="flex items-center gap-2 py-1" data-testid={`panels-row-${id}`}>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{names.panel(id)}</div>
          <div className="truncate text-[11.5px] text-muted-foreground" data-testid={`panels-where-${id}`}>
            {where}
          </div>
        </div>
        {!showing && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid={`panels-show-${id}`}
            onClick={() => dock.show(id)}
          >
            {t("editor.dock.show")}
          </Button>
        )}
        <span className="w-8 shrink-0 text-end text-xs text-muted-foreground">{keys.show(n)}</span>
      </div>
    )
  }

  const foldedNames = undoTargets(dock.layout).map((u) =>
    u === "left"
      ? t("editor.dock.foldedLeftPanel")
      : u === "tl"
        ? t("editor.dock.foldedTimeline")
        : u === "ll"
          ? t("editor.dock.foldedBottomLeft")
          : t("editor.dock.foldedBottomRight"),
  )

  return (
    <Popover open={dock.panelsOpen} onOpenChange={dock.setPanelsOpen}>
      <AppTooltip content={t("editor.dock.panelsTip", { keys: keys.panels })} disabled={dock.panelsOpen}>
        <PopoverTrigger
          render={
            <Button type="button" variant="outline" size="sm" data-testid="panels-button">
              <LayoutGrid />
              {t("editor.dock.panels")}
              <span className="text-xs font-normal text-muted-foreground">{keys.panels}</span>
            </Button>
          }
        />
      </AppTooltip>
      <PopoverContent align="end" className="w-[380px] gap-2 p-3" data-testid="panels-menu">
        {status && <div className="border-b border-border pb-2">{status}</div>}
        {full && dock.canRestore && (
          <div
            data-testid="panels-full-note"
            className="flex flex-col gap-2 rounded-md bg-sky-50 p-2 text-xs text-sky-900 dark:bg-sky-950/60 dark:text-sky-200"
          >
            <span>{t("editor.dock.fullNote", { folded: foldedNames.join(", ") })}</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="self-start"
              data-testid="panels-restore"
              onClick={() => {
                dock.restore()
                dock.setPanelsOpen(false)
              }}
            >
              <Shrink />
              {t("editor.dock.restore")}
              <span className="font-normal text-muted-foreground">{keys.restore}</span>
            </Button>
          </div>
        )}
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("editor.dock.panelsOnFile")}
        </div>
        <div className="flex flex-col">
          {row("timeline", 1)}
          {(v.present.includes("film") || filmHiddenByTiming) && row("film", 2)}
          {row("text", 3)}
        </div>
        <div className="flex flex-col gap-1.5 border-t border-border pt-2">
          <div className="flex items-center gap-2">
            <Button type="button" size="xs" variant="outline" data-testid="panels-reset" onClick={dock.resetLayout}>
              <RotateCcw />
              {t("editor.dock.resetLayout")}
            </Button>
            <VoiceInfoTip
              label={t("editor.dock.resetInfoAria")}
              content={`${t("editor.dock.rememberedNote", { file: fileName })} ${t(START_KEY[kind])}`}
            />
          </div>
          <div className="text-[11px] text-muted-foreground" data-testid="panels-keys">
            {t("editor.dock.keysHint", { panels: keys.panels, full: keys.full, fold: keys.fold, restore: keys.restore })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
