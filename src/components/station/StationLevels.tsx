// The fade corners and the volume line (AQU-2327, spec items 21–22), shown
// while the pointer is over the lane: board 40 drawing 6, with 40b's working
// drags. Both are the clip's own data (cell.audio.gain) — they never change
// the recording, and each change is one Undo step (`take.gain`).

import { useRef, type PointerEvent } from "react"
import { useT } from "@/lib/i18n/I18nProvider"
import { round2 } from "@/lib/station/edit-list"
import type { StationEditor } from "./useStationEditor"

/** 40b: the line sits 4% higher for each dB (0 dB at the middle). */
const PCT_PER_DB = 4
const MIN_DB = -12
const MAX_DB = 6

type Drag = { kind: "fadeIn" | "fadeOut" | "vol"; x: number; y: number; moved: boolean }

export function StationLevels({ ed, lane, hover }: { ed: StationEditor; lane: HTMLElement | null; hover: boolean }) {
  const t = useT()
  const dragRef = useRef<Drag | null>(null)
  const { va, w } = ed.view
  const pct = (x: number) => `${(((Math.max(va, Math.min(va + w, x)) - va) / w) * 100).toFixed(3)}%`
  const lv = ed.level
  const kept = ed.trimB - ed.trimA
  const step = kept > 2 ? 0.3 : 0.05

  const at = (e: PointerEvent) => {
    const r = lane?.getBoundingClientRect()
    if (!r || r.width <= 0) return { t: va, y: 0.5 }
    return { t: va + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * w, y: (e.clientY - r.top) / Math.max(1, r.height) }
  }
  const down = (kind: Drag["kind"]) => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { kind, x: e.clientX, y: e.clientY, moved: false }
  }
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    if (!d) return
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true
    if (!d.moved) return
    const p = at(e)
    const half = kept / 2
    if (d.kind === "fadeIn") ed.setLiveLevel({ ...lv, fadeIn: round2(Math.max(0, Math.min(half, p.t - ed.trimA))) })
    else if (d.kind === "fadeOut") ed.setLiveLevel({ ...lv, fadeOut: round2(Math.max(0, Math.min(half, ed.trimB - p.t))) })
    else ed.setLiveLevel({ ...lv, gainDb: Math.max(MIN_DB, Math.min(MAX_DB, Math.round(((0.5 - p.y) * 100) / PCT_PER_DB * 2) / 2)) })
  }
  const up = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (d.moved) {
      void ed.commitLevel(ed.level)
      return
    }
    // A click on a corner turns its fade on or off (40b).
    if (d.kind === "fadeIn") void ed.commitLevel({ ...lv, fadeIn: lv.fadeIn > 0 ? 0 : step })
    if (d.kind === "fadeOut") void ed.commitLevel({ ...lv, fadeOut: lv.fadeOut > 0 ? 0 : step })
  }

  if (!hover) return null
  const fadeInT = lv.fadeIn > 0 ? t("editor.station.fadeInLen", { len: lv.fadeIn.toFixed(2) }) : t("editor.station.fadeIn")
  const fadeOutT = lv.fadeOut > 0 ? t("editor.station.fadeOutLen", { len: lv.fadeOut.toFixed(2) }) : t("editor.station.fadeOut")
  const volTop = `${50 - lv.gainDb * PCT_PER_DB}%`
  const volT = `${lv.gainDb > 0 ? "+" : lv.gainDb < 0 ? "−" : ""}${Math.abs(lv.gainDb)} dB`
  const corner = "absolute top-[15px] z-[5] size-3 cursor-pointer touch-none rounded-[2px] border-[1.5px] border-sky-700 bg-white p-0 dark:bg-background"
  return (
    <>
      {/* Item 22: the volume line and its readout. */}
      <span
        data-testid="station-volume-line"
        title={t("editor.station.volumeDragTip")}
        onPointerDown={down("vol")}
        onPointerMove={move}
        onPointerUp={up}
        className="absolute inset-x-0 z-[4] h-[11px] cursor-ns-resize touch-none"
        style={{ top: `calc(${volTop} - 5px)` }}
      >
        <span aria-hidden className="absolute inset-x-0 top-[5px] h-px bg-sky-700 opacity-70" />
      </span>
      <span
        className="absolute right-1.5 z-[5] inline-flex -translate-y-1/2 items-center gap-0.5 rounded-[4.8px] bg-white px-0.5 py-px ring-1 ring-sky-200 dark:bg-background dark:ring-sky-900"
        style={{ top: volTop }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label={t("editor.station.quieter")}
          title={t("editor.station.quieterTip")}
          onClick={() => void ed.commitLevel({ ...lv, gainDb: Math.max(MIN_DB, lv.gainDb - 3) })}
          className="size-[18px] p-0 text-[13px] text-sky-700 dark:text-sky-400"
        >
          −
        </button>
        <span
          data-testid="station-volume"
          onPointerDown={down("vol")}
          onPointerMove={move}
          onPointerUp={up}
          className="cursor-ns-resize touch-none font-mono text-[10.5px] text-sky-700 dark:text-sky-400"
        >
          {volT}
        </span>
        <button
          type="button"
          aria-label={t("editor.station.louder")}
          title={t("editor.station.louderTip")}
          onClick={() => void ed.commitLevel({ ...lv, gainDb: Math.min(MAX_DB, lv.gainDb + 3) })}
          className="size-[18px] p-0 text-[13px] text-sky-700 dark:text-sky-400"
        >
          +
        </button>
      </span>
      {/* Item 21: the fade corners, where each fade ends (40b). */}
      <button
        type="button"
        data-testid="station-fade-in"
        aria-label={fadeInT}
        title={t("editor.station.fadeTip", { fade: fadeInT })}
        onPointerDown={down("fadeIn")}
        onPointerMove={move}
        onPointerUp={up}
        className={corner}
        style={{ left: pct(ed.trimA + lv.fadeIn) }}
      />
      <span className="pointer-events-none absolute top-[29px] z-[5] ps-4 text-[10.5px] whitespace-nowrap text-sky-700 dark:text-sky-400" style={{ left: pct(ed.trimA + lv.fadeIn) }}>
        {fadeInT}
      </span>
      <button
        type="button"
        data-testid="station-fade-out"
        aria-label={fadeOutT}
        title={t("editor.station.fadeTip", { fade: fadeOutT })}
        onPointerDown={down("fadeOut")}
        onPointerMove={move}
        onPointerUp={up}
        className={`${corner} -translate-x-full`}
        style={{ left: pct(ed.trimB - lv.fadeOut) }}
      />
    </>
  )
}
