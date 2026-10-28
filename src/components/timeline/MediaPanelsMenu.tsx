// The Panels button and its menu. (Media redesign, layout — canvas board 23,
// "Lean chrome: your mix", Oct 24.)
//
// A folded panel leaves nothing behind, so this is the way back to every one
// of them: the film and the text, each a row you click to show or hide (✓
// while it shows) with its key, where it sits in the row's tooltip; the way
// out of full screen; and Reset layout, with the shortcuts behind its (i).
// ⌘\ opens it from anywhere in the media view.
//
// Sam, Oct 28 ("a little bit too much going on… redundancy with the status
// circle"): no status line — Live / Synced and the line counts are the top
// bar's status ring's — and no Timeline row: it is always there, and ⌥1
// still brings it back.

import { Check, LayoutGrid, RotateCcw, Shrink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AppTooltip } from "@/components/ui/tooltip"
import { VoiceInfoTip } from "@/components/voice/VoiceInfoTip"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
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
}

export function MediaPanelsMenu({ dock, fileName, kind, filmHiddenByTiming }: MediaPanelsMenuProps) {
  const t = useT()
  const names = usePanelNames()
  const keys = dockKeys()
  const v = dock.view
  const full = dock.fullRegion

  const stateWords = (parts: Array<string | null | false>) => parts.filter(Boolean).join(" · ")

  const row = (id: DockPanel, n: number) => {
    let where: string
    let showing: boolean
    let toggle: (() => void) | null = null
    if (id === "film" && filmHiddenByTiming) {
      showing = false
      where = t("editor.dock.filmHiddenByTiming")
    } else {
      const area = v.areaOf(id)!
      const active = v.activeOf(area)
      showing = v.isShowing(id)
      // Where it sits, and why it is out of sight when it is — never "showing".
      where = stateWords([
        names.area(area),
        !v.isOpen(area)
          ? t("editor.dock.stateFolded")
          : active !== id && active && t("editor.dock.stateBehind", { panel: names.panel(active) }),
        full === area && t("editor.dock.stateFull"),
      ])
      toggle = showing ? () => dock.fold(area) : () => dock.show(id)
    }
    return (
      <AppTooltip key={id} content={where} side="left">
        <button
          type="button"
          data-testid={`panels-row-${id}`}
          aria-pressed={showing}
          aria-description={where}
          disabled={!toggle}
          onClick={() => toggle?.()}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] font-medium transition-colors hover:bg-accent/50 disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          <Check className={cn("size-3.5 shrink-0", !showing && "invisible")} aria-hidden />
          <span className="min-w-0 flex-1 truncate">{names.panel(id)}</span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground">{keys.show(n)}</span>
        </button>
      </AppTooltip>
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
      <PopoverContent align="end" className="w-64 gap-1.5 p-2" data-testid="panels-menu">
        {full && dock.canRestore && (
          // One short line; what full screen folded is in its tooltip.
          <AppTooltip content={t("editor.dock.fullNote", { folded: foldedNames.join(", ") })} side="left">
            <div
              data-testid="panels-full-note"
              className="flex items-center gap-2 rounded-md bg-sky-50 px-2 py-1 text-xs text-sky-900 dark:bg-sky-950/60 dark:text-sky-200"
            >
              <span className="min-w-0 flex-1 truncate">{t("editor.dock.fullOn")}</span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                data-testid="panels-restore"
                aria-label={t("editor.dock.restore")}
                onClick={() => {
                  dock.restore()
                  dock.setPanelsOpen(false)
                }}
              >
                <Shrink />
                {t("editor.dock.restoreShort")}
                <span className="font-normal text-muted-foreground">{keys.restore}</span>
              </Button>
            </div>
          </AppTooltip>
        )}
        <div className="px-2 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground" data-testid="panels-heading">
          {t("editor.dock.panels")}
        </div>
        <div className="flex flex-col">
          {(v.present.includes("film") || filmHiddenByTiming) && row("film", 2)}
          {row("text", 3)}
        </div>
        <div className="flex items-center gap-1 border-t border-border pt-1.5">
          <button
            type="button"
            data-testid="panels-reset"
            onClick={dock.resetLayout}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] font-medium transition-colors hover:bg-accent/50"
          >
            <RotateCcw className="size-3.5 shrink-0" aria-hidden />
            {t("editor.dock.resetLayout")}
          </button>
          <VoiceInfoTip
            label={t("editor.dock.resetInfoAria")}
            content={
              <span className="flex flex-col gap-1.5" data-testid="panels-reset-info">
                <span>{`${t("editor.dock.rememberedNote", { file: fileName })} ${t(START_KEY[kind])}`}</span>
                <span data-testid="panels-keys">
                  {t("editor.dock.keysHint", { panels: keys.panels, full: keys.full, fold: keys.fold, restore: keys.restore })}
                </span>
              </span>
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
