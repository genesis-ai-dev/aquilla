// The media view's one 40 px bar. (Media redesign, layout — canvas board 23,
// "Lean chrome: your mix", from board 20: "Play, previous and next line, the
// time, speed 0.5–2× and volume join the toolbar and the timeline's tools in
// one 40 px bar. No play bar at the bottom.")
//
// Left to right: the transport, a separator, the film, the timeline's tools
// (portaled into the "media-top-tools" slot by TimelineEditor, which owns
// them), and at the right the status ring, History, the mode toggle and the
// Panels button. It replaces three rows: the toolbar row above the view, the
// timeline's own title row, and the play bar at the bottom of the window.

import type { ReactNode } from "react"
import { ChevronDown, EyeOff, Film, Link2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { youTubeVideoId } from "@/lib/video/youtube"
import { uiSlotRef } from "@/lib/ui-slots"

/**
 * What to call a linked film on the button: its file's name where the address
 * has one, the folder above a streaming playlist (whose own name is always
 * "master.m3u8"), and the video's id on YouTube.
 */
export function filmLabelFor(url: string, fallback: string): string {
  const yt = youTubeVideoId(url)
  if (yt) return `YouTube ${yt}`
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p))
    let name = parts.at(-1) ?? ""
    if (/^(master|index|playlist)\.m3u8$/i.test(name)) name = parts.at(-2) ?? ""
    // A storage id ("cmkaom6vg0000bca7bh…") names nothing a person would
    // recognise: the file the film belongs to says more.
    if (!name || (/^[a-z0-9_-]{16,}$/i.test(name) && /\d/.test(name) && !/[._ ]/.test(name))) return fallback
    return name
  } catch {
    return fallback
  }
}

export interface MediaFilmButtonProps {
  /** The linked film's address, or null when the file has none. */
  url: string | null
  /** What to call it when its address names nothing readable: the file's name. */
  fallbackName: string
  /** Free timing hides the film: the menu says so instead of offering Hide. */
  hiddenByTiming: boolean
  /** The film's panel is on screen. */
  showing: boolean
  onHide(): void
  onShow(): void
  /** Opens the link-video dialog (change, or clear). Absent below the floor. */
  onLink?: () => void
}

/** "Film: <name> ⌄" — change, hide or clear. "Link video" while there is none. */
export function MediaFilmButton({ url, fallbackName, hiddenByTiming, showing, onHide, onShow, onLink }: MediaFilmButtonProps) {
  const t = useT()
  if (!url) {
    if (!onLink) return null
    return (
      <Button type="button" variant="outline" size="sm" data-testid="top-film" onClick={onLink}>
        <Film />
        {t("editor.timeline.linkVideo")}
      </Button>
    )
  }
  const name = filmLabelFor(url, fallbackName)
  return (
    <DropdownMenu>
      <AppTooltip content={t("editor.dock.filmTip")}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="top-film"
              // The linked film reads as "on", in the app's selected tint.
              className="max-w-52 border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-200"
            >
              <Film />
              <span className="truncate">{t("editor.dock.filmLabel", { name })}</span>
              <ChevronDown className="size-3" />
            </Button>
          }
        />
      </AppTooltip>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{name}</DropdownMenuLabel>
          {onLink && (
            <DropdownMenuItem onClick={onLink} data-testid="top-film-change">
              <Link2 />
              {t("editor.dock.filmChange")}
            </DropdownMenuItem>
          )}
          {hiddenByTiming ? (
            <DropdownMenuLabel className="font-normal">{t("editor.dock.filmHiddenByTiming")}</DropdownMenuLabel>
          ) : showing ? (
            <DropdownMenuItem onClick={onHide} data-testid="top-film-hide">
              <EyeOff />
              {t("editor.dock.filmHide")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={onShow} data-testid="top-film-show">
              <Film />
              {t("editor.dock.filmShow")}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function MediaTopBar({
  transport,
  film,
  trailing,
}: {
  /** The play bar's toolbar variant. */
  transport: ReactNode
  film: ReactNode
  /** Status ring, History, the mode toggle, Panels — right-aligned. */
  trailing: ReactNode
}) {
  return (
    <div
      data-testid="media-top-bar"
      className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-muted/30 px-2"
    >
      {transport}
      <div aria-hidden className="h-[22px] w-px shrink-0 bg-border" />
      {film}
      {/* The timeline's tools land here (TimelineEditor portals them). */}
      <div ref={uiSlotRef("media-top-tools")} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden" />
      <div className="ms-auto flex shrink-0 items-center gap-1.5">{trailing}</div>
    </div>
  )
}
