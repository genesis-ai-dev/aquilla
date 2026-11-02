// The Station's waveform lane (AQU-2327, spec items 9–23). The waveform is
// the app's own take rectangle (WaveformRect), so the Station follows the
// timeline's look and picks up AQU-2235's when it lands; everything around it
// — the in-lane ruler, the Start and End flags, the selection, the cursor and
// its actions — is drawn as board 40 draws it.

import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { Check, Plus, Trash2 } from "lucide-react"
import { WaveformRect } from "@/components/audio/WaveformRect"
import { TRIM_NUDGE_COARSE_SEC, TRIM_NUDGE_SEC } from "@/lib/audio/trim-edit"
import { useT } from "@/lib/i18n/I18nProvider"
import { joinsOf, round2, type ClipMix } from "@/lib/station/edit-list"
import { viewPeaks } from "@/lib/station/render"
import { formatStationLength, formatStationTime, rulerTicks } from "@/lib/station/time"
import { cn } from "@/lib/utils"
import { isRange, type StationEditor } from "./useStationEditor"
import { useBox } from "./useBox"

const pctOf = (x: number, va: number, w: number) => `${(((Math.max(va, Math.min(va + w, x)) - va) / w) * 100).toFixed(3)}%`

interface LaneProps {
  ed: StationEditor
  editable: boolean
  trackVars: Record<string, string>
  generated: boolean
  /** Slice 5: Delete this / Insert audio here, and the Insert menu. */
  onDelete?(): void
  onInsert?(): void
  insertOpen?: boolean
  insertMenu?: ReactNode
  /** Items 21–22, shown while the pointer is over the lane (slice 7). */
  hoverLayer?: (hover: boolean, lane: HTMLElement | null) => ReactNode
  /** The pointer is over the lane: the quiet hint steps aside (item 29). */
  onHover?(hover: boolean): void
  /** Slice 12: why Delete and Insert aren't offered (a very long recording). */
  editNote?: string
  /** Slice 14: Record now, at `at`, with its flag's words. `t1` is where the
   *  recording so far ends, once it runs. The selection's actions step aside. */
  recording?: { at: number; t1: number | null; flag: string }
}

type Drag =
  | { kind: "sel"; x: number; y: number; t0: number; moved: boolean }
  | { kind: "trimA" | "trimB"; x: number; y: number; moved: boolean }

export function StationLane({ ed, editable, trackVars, generated, onDelete, onInsert, insertOpen, insertMenu, hoverLayer, onHover, editNote, recording }: LaneProps) {
  const t = useT()
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const size = useBox(box)
  const [hover, setHover] = useState(false)
  const dragRef = useRef<Drag | null>(null)
  const { va, vb, w } = ed.view
  const pct = (x: number) => pctOf(x, va, w)
  const inView = (x: number) => x >= va - 1e-6 && x <= vb + 1e-6

  // Item 11: one peak per 2 px, against the recording's loudest sample with
  // 5% headroom, shaped by its volume and fades.
  const bins = Math.max(8, Math.round(size.width / 2))
  const peaks = useMemo(
    () => (ed.pcm ? viewPeaks(ed.placed, ed.lookup, va, vb, bins, ed.pcm.peak * 1.05, ed.clip) : null),
    [ed.pcm, ed.placed, ed.lookup, va, vb, bins, ed.clip],
  )

  const timeAt = (clientX: number) => {
    const r = box?.getBoundingClientRect()
    if (!r || r.width <= 0) return va
    const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return round2(va + x * w)
  }

  // Item 12: drag across to select, click for the cursor; a press while it
  // plays pauses it when you let go.
  const onLaneDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !ed.pcm) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const t0 = timeAt(e.clientX)
    dragRef.current = { kind: "sel", x: e.clientX, y: e.clientY, t0, moved: false }
    ed.select(t0, t0)
    e.currentTarget.focus({ preventScroll: true })
  }
  const onFlagDown = (kind: "trimA" | "trimB") => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !editable) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { kind, x: e.clientX, y: e.clientY, moved: false }
  }
  const onMove = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    if (!d) return
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true
    if (!d.moved) return
    const tm = timeAt(e.clientX)
    if (d.kind === "sel") ed.select(d.t0, Math.max(0, Math.min(ed.length, tm)))
    else if (d.kind === "trimA") ed.setLiveTrim({ a: Math.max(0, Math.min(ed.trimB - 0.05, tm)), b: ed.trimB })
    else ed.setLiveTrim({ a: ed.trimA, b: Math.min(ed.length, Math.max(ed.trimA + 0.05, tm)) })
  }
  const onUp = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (d.kind === "sel") {
      const s = ed.sel
      if (!d.moved || !s || s.b - s.a < 0.02) ed.select(d.t0, d.t0)
      if (ed.playing) ed.pause()
      return
    }
    // A flag let go: the trim it ended on is one Undo step.
    if (d.moved && ed.liveTrim) void ed.commitTrim(ed.liveTrim.a, ed.liveTrim.b)
    else ed.setLiveTrim(null)
  }
  const onFlagKey = (kind: "trimA" | "trimB") => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!editable || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return
    e.preventDefault()
    e.stopPropagation()
    const step = (e.shiftKey ? TRIM_NUDGE_COARSE_SEC : TRIM_NUDGE_SEC) * (e.key === "ArrowLeft" ? -1 : 1)
    if (kind === "trimA") void ed.commitTrim(round2(ed.trimA + step), ed.trimB)
    else void ed.commitTrim(ed.trimA, round2(ed.trimB + step))
  }

  const sel = ed.sel
  const range = isRange(sel)
  const point = sel != null && !range
  const keep = { start: (ed.trimA - va) / w, end: (ed.trimB - va) / w }
  const progress = ed.playT != null ? (ed.playT - va) / w : null
  const mid = sel ? Math.max(16, Math.min(84, (((sel.a + sel.b) / 2 - va) / w) * 100)) : 50
  const joins = joinsOf(ed.placed).filter(inView)
  // Slice 13: below 520 px the bar's actions keep their icons and tooltips
  // and drop their words, so it fits over the lane.
  const narrow = size.width > 0 && size.width < 520
  const inserted = ed.placed.filter((g) => g.ins && g.t1 > va && g.t0 < vb)

  return (
    <div className="relative flex min-h-[190px] flex-1 flex-col px-3 pt-[62px]">
      <div
        ref={setBox}
        role="group"
        tabIndex={-1}
        aria-label={t("editor.station.laneTip")}
        title={t("editor.station.laneTip")}
        data-testid="station-lane"
        onPointerDown={onLaneDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerEnter={() => {
          setHover(true)
          onHover?.(true)
        }}
        onPointerLeave={() => {
          if (dragRef.current) return
          setHover(false)
          onHover?.(false)
        }}
        className="relative min-h-[128px] flex-1 cursor-text touch-none outline-none select-none"
      >
        {size.height > 0 ? (
          <WaveformRect
            peaks={peaks}
            height={size.height}
            kind={generated ? "generated" : "take"}
            trackVars={trackVars}
            keep={keep}
            progress={progress}
            playing={ed.playing}
            holdProgress={ed.playT != null}
            loading={ed.status === "loading"}
            className="absolute inset-0"
            testId="station-wave"
          >
            {/* Item 10: the ruler inside the lane — a faint line and a time each step. */}
            {rulerTicks(va, vb).map((tk) => (
              <span
                key={tk}
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-foreground/10"
                style={{ left: pct(tk) }}
              >
                <span className="absolute top-[3px] left-1 font-mono text-[9.5px] leading-[11px] whitespace-nowrap text-muted-foreground/70">
                  {formatStationTime(tk)}
                </span>
              </span>
            ))}
          </WaveformRect>
        ) : null}

        {/* Item 19: inserted audio, marked until it is saved. */}
        {inserted.map((g) => (
          <span
            key={`ins-${g.t0}`}
            title={t("editor.station.insertedMark", { label: g.ins ?? "" })}
            className="pointer-events-none absolute top-0 bottom-0 z-[1] bg-amber-500/18 shadow-[inset_0_-3px_0_var(--color-amber-500)]"
            style={{ left: pct(g.t0), width: `${((Math.min(vb, g.t1) - Math.max(va, g.t0)) / w) * 100}%` }}
          />
        ))}
        {/* Item 21: a fade, always shown — a line from the bottom of the kept
            part's edge up to where the fade ends, the part it quiets shaded. */}
        {ed.clip.fadeIn > 0 || ed.clip.fadeOut > 0 ? <FadeShapes clip={ed.clip} va={va} w={w} /> : null}
        {/* Item 20: where a part was deleted. */}
        {joins.map((j) => (
          <span
            key={`join-${j}`}
            title={t("editor.station.joinMark")}
            className="pointer-events-none absolute top-0 bottom-0 z-[2] w-0 border-l-[1.5px] border-dashed border-red-600"
            style={{ left: pct(j) }}
          />
        ))}

        {/* Item 15: the selected range. */}
        {sel && range ? (
          <span
            aria-hidden
            data-testid="station-selection"
            className="pointer-events-none absolute top-0 bottom-0 z-[2] bg-sky-500/16 shadow-[inset_1px_0_0_var(--color-sky-500),inset_-1px_0_0_var(--color-sky-500)]"
            style={{ left: pct(sel.a), width: `${((Math.min(vb, sel.b) - Math.max(va, sel.a)) / w) * 100}%` }}
          />
        ) : null}

        {/* Item 14: Start and End, dragged to trim. */}
        {inView(ed.trimA) ? (
          <Flag
            at={pct(ed.trimA)}
            side="start"
            label={t("editor.station.startFlag", { time: formatStationTime(ed.trimA) })}
            aria={t("editor.station.dragStart")}
            editable={editable}
            onPointerDown={onFlagDown("trimA")}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onKeyDown={onFlagKey("trimA")}
          />
        ) : null}
        {inView(ed.trimB) ? (
          <Flag
            at={pct(ed.trimB)}
            side="end"
            label={t("editor.station.endFlag", { time: formatStationTime(ed.trimB) })}
            aria={t("editor.station.dragEnd")}
            editable={editable}
            onPointerDown={onFlagDown("trimB")}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onKeyDown={onFlagKey("trimB")}
          />
        ) : null}
        {/* Slice 14: the recording being made, red, growing from the cursor. */}
        {recording && recording.t1 != null ? (
          <span
            aria-hidden
            data-testid="station-rec-part"
            className="pointer-events-none absolute top-0 bottom-0 z-[3] bg-red-500/16 shadow-[inset_-2px_0_0_var(--color-red-600)]"
            style={{ left: pct(recording.at), width: `${((Math.min(vb, recording.t1) - Math.max(va, recording.at)) / w) * 100}%` }}
          />
        ) : null}
        {recording && inView(recording.at) ? (
          <Flag
            at={pct(recording.at)}
            side="rec"
            label={recording.flag}
          />
        ) : null}
        {/* Item 16: the cursor. */}
        {!recording && point && inView(sel.a) ? (
          <Flag at={pct(sel.a)} side="mid" label={t("editor.station.insertFlag", { time: formatStationTime(sel.a) })} />
        ) : null}

        {hoverLayer?.(hover, box)}

        {/* Item 17: the actions at the selection. */}
        {!recording && sel && (range || onInsert) ? (
          <div
            data-testid="station-actions"
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute -top-[62px] z-[6] flex -translate-x-1/2 flex-col items-center gap-1"
            style={{ left: `${mid}%` }}
          >
            <div className="flex items-center gap-0.5 rounded-md bg-popover p-[3px] whitespace-nowrap shadow-md ring-1 ring-border">
              {range && editable ? (
                <ActionButton tip={t("editor.station.keepTip")} onClick={() => void ed.keepSelection()} testId="station-keep" className="text-foreground">
                  <Check className="size-[13px]" />
                  {narrow ? <span className="sr-only">{t("editor.station.keepThis")}</span> : t("editor.station.keepThis")}
                </ActionButton>
              ) : null}
              {range && onDelete ? (
                <ActionButton tip={t("editor.station.deleteTip")} onClick={onDelete} testId="station-delete" className="text-destructive">
                  <Trash2 className="size-[13px]" />
                  {narrow ? <span className="sr-only">{t("editor.station.deleteThis")}</span> : t("editor.station.deleteThis")}
                </ActionButton>
              ) : null}
              {onInsert ? (
                <ActionButton tip={t("editor.station.insertTip")} onClick={onInsert} testId="station-insert" className="text-sky-700 dark:text-sky-400" expanded={insertOpen}>
                  <Plus className="size-[13px]" />
                  {narrow ? <span className="sr-only">{t("editor.station.insertHere")}</span> : t("editor.station.insertHere")}
                </ActionButton>
              ) : null}
              {editNote ? <span className="px-1 text-[11px] text-muted-foreground/70">{editNote}</span> : null}
              <span className="ps-1 pe-1.5 font-mono text-[10.5px] text-muted-foreground/70">
                {range
                  ? t("editor.station.selRange", { a: formatStationTime(sel.a), b: formatStationTime(sel.b), len: formatStationLength(sel.b - sel.a) })
                  : t("editor.station.selAt", { time: formatStationTime(sel.a) })}
              </span>
            </div>
            {insertOpen ? insertMenu : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ActionButton({
  tip,
  onClick,
  testId,
  className,
  expanded,
  children,
}: {
  tip: string
  onClick(): void
  testId: string
  className?: string
  expanded?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={tip}
      data-testid={testId}
      aria-expanded={expanded}
      onClick={onClick}
      className={cn("inline-flex h-6 items-center gap-1 rounded-sm px-1 text-xs font-semibold whitespace-nowrap hover:bg-accent", className)}
    >
      {children}
    </button>
  )
}

/** Item 21: each fade as a line from silence at the kept part's edge up to
 *  full level where the fade ends, and the part it quiets shaded above the
 *  line. The waveform under it is already drawn faded (viewPeaks). */
export function FadeShapes({ clip, va, w }: { clip: ClipMix; va: number; w: number }) {
  const x = (t: number) => ((t - va) / w) * 1000
  const fades: { edge: number; end: number }[] = []
  if (clip.fadeIn > 0) fades.push({ edge: x(clip.trimA), end: x(clip.trimA + clip.fadeIn) })
  if (clip.fadeOut > 0) fades.push({ edge: x(clip.trimB), end: x(clip.trimB - clip.fadeOut) })
  return (
    <svg
      aria-hidden
      data-testid="station-fades"
      viewBox="0 0 1000 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 z-[2] h-full w-full overflow-hidden rounded-[6px]"
    >
      {fades.map((f) => (
        <g key={f.edge}>
          <polygon points={`${f.edge},0 ${f.end},0 ${f.edge},100`} className="fill-background/55" />
          <line
            x1={f.edge}
            y1={100}
            x2={f.end}
            y2={0}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            className="stroke-sky-700 dark:stroke-sky-400"
          />
        </g>
      ))}
    </svg>
  )
}

/** Start and End are blue, the cursor amber, and a recording being made red. */
const FLAG_INK = {
  start: { bg: "bg-sky-700", point: "border-t-sky-700" },
  end: { bg: "bg-sky-700", point: "border-t-sky-700" },
  mid: { bg: "bg-amber-700", point: "border-t-amber-700" },
  rec: { bg: "bg-red-600", point: "border-t-red-600" },
} as const

/** Item 14 and 16: a flag above the lane, with its line down through it. */
function Flag({
  at,
  side,
  label,
  aria,
  editable = false,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown,
}: {
  at: string
  side: "start" | "end" | "mid" | "rec"
  label: string
  aria?: string
  editable?: boolean
  onPointerDown?(e: PointerEvent<HTMLElement>): void
  onPointerMove?(e: PointerEvent<HTMLElement>): void
  onPointerUp?(e: PointerEvent<HTMLElement>): void
  onKeyDown?(e: KeyboardEvent<HTMLButtonElement>): void
}) {
  const ink = FLAG_INK[side]
  const edge = side === "start" || side === "end"
  // Start and End are a flag on a pole: the tab, its point and the line share
  // one straight side, on the kept part's side of the edge. The cursor's and
  // a recording's flags stand centred on their line.
  const tab = cn(
    "absolute top-0 h-[18px] rounded-[3px] px-1.5 text-[10.5px] leading-[18px] font-semibold whitespace-nowrap text-white",
    ink.bg,
    side === "start" ? "left-0 rounded-bl-none" : side === "end" ? "right-0 rounded-br-none" : "left-0 -translate-x-1/2",
  )
  const point =
    side === "start"
      ? "left-0 border-t-[5px] border-r-[5px] border-r-transparent"
      : side === "end"
        ? "-left-[5px] border-t-[5px] border-l-[5px] border-l-transparent"
        : "-left-[5px] border-x-[5px] border-t-[5px] border-x-transparent"
  const pole = side === "start" ? "left-0" : side === "end" ? "-left-[1.5px]" : "-left-[0.75px]"
  return (
    <span className="group/flag absolute -top-[23px] bottom-0 z-[5] w-0" style={{ left: at }} data-testid={`station-flag-${side}`}>
      {onPointerDown ? (
        <button
          type="button"
          aria-label={`${aria ?? label}: ${label}`}
          title={aria}
          disabled={!editable}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
          className={cn(tab, editable ? "cursor-ew-resize touch-none" : "cursor-default opacity-90")}
        >
          {label}
        </button>
      ) : (
        <span className={tab}>{label}</span>
      )}
      <span aria-hidden className={cn("absolute top-[18px] h-0 w-0", point, ink.point)} />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-[18px] bottom-0 w-[1.5px] transition-[width]",
          pole,
          ink.bg,
          edge && editable && "group-hover/flag:w-[3px]",
          edge && editable && side === "end" && "group-hover/flag:-left-[3px]",
        )}
      />
      {/* Sam, Nov 2: the edge itself drags, the whole height of the lane,
          not only the tab above it. */}
      {edge && onPointerDown ? (
        <span
          aria-hidden
          data-testid={`station-edge-${side}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className={cn(
            "absolute top-[23px] bottom-0 w-3 touch-none",
            side === "start" ? "-left-1" : "-left-2",
            editable ? "cursor-ew-resize" : "pointer-events-none",
          )}
        />
      ) : null}
    </span>
  )
}
