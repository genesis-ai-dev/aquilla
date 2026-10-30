// The Station's transport row and what hangs off it (AQU-2327, spec items
// 24–29, 31–32): Play, the listening speed, the time, zoom, Start / End / the
// kept length (click to type), the typing help row, the zoom scroll bar and
// the quiet hint.

import { useEffect, useRef, useState } from "react"
import { Pause, Play, Repeat } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useT } from "@/lib/i18n/I18nProvider"
import { clampTrim } from "@/lib/station/edit-list"
import { formatStationLength, formatStationTime, parseStationTime } from "@/lib/station/time"
import { cn } from "@/lib/utils"
import { isRange, MAX_ZOOM, SPEEDS, type StationEditor } from "./useStationEditor"

/** Item 32: under the lane while zoomed. */
export function StationScroll({ ed }: { ed: StationEditor }) {
  const t = useT()
  const { zoom, w, va } = ed.view
  if (zoom <= 1) return null
  const max = Math.max(0, ed.length - w)
  return (
    <div className="shrink-0 px-3 pt-2">
      <input
        type="range"
        min={0}
        max={1000}
        value={max > 0 ? Math.round((va / max) * 1000) : 0}
        onChange={(e) => ed.setViewStart((max * Number(e.target.value)) / 1000)}
        aria-label={t("editor.station.scroll")}
        className="m-0 w-full accent-sky-700"
      />
    </div>
  )
}

export function StationTransport({
  ed,
  editable,
  calm,
  hint,
  onMessage,
}: {
  ed: StationEditor
  editable: boolean
  /** Item 29: nothing selected, typed, hovered or unsaved. */
  calm: boolean
  hint: string
  onMessage(text: string): void
}) {
  const t = useT()
  const [typing, setTyping] = useState<"start" | "end" | null>(null)
  const [typed, setTyped] = useState("")
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (typing) inputRef.current?.select()
  }, [typing])

  const startTyping = (which: "start" | "end") => {
    if (!editable) return
    ed.clearSel()
    setTyping(which)
    setTyped(formatStationTime(which === "start" ? ed.trimA : ed.trimB))
  }
  const setTypedTime = () => {
    const v = parseStationTime(typed)
    if (v == null) {
      onMessage(t("editor.station.badTime"))
      return
    }
    const c = typing === "start" ? clampTrim(v, ed.trimB, ed.length) : clampTrim(ed.trimA, v, ed.length)
    setTyping(null)
    void ed.commitTrim(c.trimA, c.trimB)
  }

  const range = isRange(ed.sel)
  const playTip = ed.playing ? t("editor.station.pause") : range ? t("editor.station.playSelection") : t("editor.station.play")
  const at = ed.playT != null ? Math.max(0, Math.min(ed.trimB, ed.playT) - ed.trimA) : 0
  const field = (which: "start" | "end") => {
    const label = which === "start" ? t("editor.station.start") : t("editor.station.end")
    const value = formatStationTime(which === "start" ? ed.trimA : ed.trimB)
    if (typing === which) {
      return (
        <span className="inline-flex h-[26px] items-center gap-1 rounded-[4.8px] border border-sky-500 bg-background px-1.5 text-[11.5px] text-muted-foreground ring-3 ring-sky-500/15">
          {label}
          <input
            ref={inputRef}
            data-testid={`station-typed-${which}`}
            aria-label={label}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter") {
                e.preventDefault()
                setTypedTime()
              } else if (e.key === "Escape") {
                e.preventDefault()
                setTyping(null)
              }
            }}
            className="h-5 w-[72px] border-0 bg-transparent p-0 font-mono text-[11.5px] text-foreground outline-none"
          />
        </span>
      )
    }
    return (
      <button
        type="button"
        data-testid={`station-field-${which}`}
        title={which === "start" ? t("editor.station.typeStartTip") : t("editor.station.typeEndTip")}
        disabled={!editable}
        onClick={() => startTyping(which)}
        className="h-[26px] cursor-text rounded-[4.8px] border border-transparent px-1.5 text-[11.5px] text-muted-foreground hover:border-border disabled:cursor-default disabled:hover:border-transparent"
      >
        {label} <span className="font-mono text-foreground">{value}</span>
      </button>
    )
  }

  return (
    <>
      <div data-testid="station-transport" className="relative flex shrink-0 flex-wrap items-center gap-1.5 px-3 pt-2.5 pb-1.5">
        {/* Item 24 */}
        <button
          type="button"
          data-testid="station-play"
          aria-label={playTip}
          title={playTip}
          disabled={ed.status !== "ready"}
          onClick={ed.togglePlay}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground text-background disabled:opacity-50"
        >
          {ed.playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="size-4" fill="currentColor" />}
        </button>
        {/* Item 25: the listening speed; the pitch is kept (preview.ts). */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                data-testid="station-speed"
                title={t("editor.station.speedTip")}
                className="h-6 px-1 text-xs font-medium whitespace-nowrap text-muted-foreground hover:text-foreground"
              />
            }
          >
            {ed.speed}× ▾
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-[120px]">
            <DropdownMenuRadioGroup value={String(ed.speed)} onValueChange={(v) => ed.setSpeed(Number(v))}>
              {SPEEDS.map((x) => (
                <DropdownMenuRadioItem key={x} value={String(x)}>
                  {x}×
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Q8: Loop, after the speed. */}
        <button
          type="button"
          data-testid="station-loop"
          aria-pressed={ed.loop}
          title={t("editor.station.loopTip")}
          onClick={ed.toggleLoop}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-sm px-1 text-xs font-semibold",
            ed.loop ? "bg-sky-500/15 text-sky-700 dark:text-sky-400" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Repeat className="size-[13px]" />
          {t("editor.station.loop")}
        </button>
        {/* Item 26 */}
        <span data-testid="station-time" className="text-[11px] text-muted-foreground tabular-nums">
          {t("editor.station.timeOf", { at: formatStationTime(at), len: formatStationTime(ed.trimB - ed.trimA) })}
        </span>
        {/* Item 31 */}
        <span className="ms-2.5 inline-flex items-center rounded-[4.8px] border border-border">
          <button
            type="button"
            aria-label={t("editor.station.zoomOut")}
            title={t("editor.station.zoomOut")}
            disabled={ed.view.zoom <= 1}
            onClick={() => ed.zoomBy(0.5)}
            className="size-6 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            −
          </button>
          <span className="min-w-[30px] text-center font-mono text-[11px] text-muted-foreground">{ed.view.zoom}×</span>
          <button
            type="button"
            aria-label={t("editor.station.zoomIn")}
            title={t("editor.station.zoomIn")}
            disabled={ed.view.zoom >= MAX_ZOOM}
            onClick={() => ed.zoomBy(2)}
            className="size-6 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            +
          </button>
        </span>
        {/* Item 27 */}
        <span className="ms-auto inline-flex items-center gap-0.5">
          {field("start")}
          {field("end")}
          <span data-testid="station-length" className="ps-1 text-[11.5px] text-muted-foreground/70">
            {formatStationLength(ed.trimB - ed.trimA)}
          </span>
        </span>
      </div>
      {/* Item 28: the typing help row. */}
      {typing ? (
        <div className="flex shrink-0 items-center justify-end gap-2 px-3 pb-1.5">
          <span className="text-[11.5px] text-muted-foreground">{t("editor.station.typeHelp")}</span>
          <Button type="button" size="xs" onClick={setTypedTime}>
            {t("editor.station.set")}
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => setTyping(null)}>
            {t("common.cancel")}
          </Button>
        </div>
      ) : null}
      {/* Item 29 */}
      {calm && !typing ? <div className="shrink-0 px-3 pb-1.5 text-[11.5px] text-muted-foreground/70">{hint}</div> : null}
    </>
  )
}
