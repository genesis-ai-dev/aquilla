// AQU-2678 (ETEN): the draggable line before the line table's Target column.
//
// It lives in an overlay grid laid over the rows with the rows' own template,
// padding and scrollbar gutter (the same trick the column headings use,
// AQU-2288). The overlay's Target cell IS the Target track in LTR and RTL
// alike, so the handle simply sits on that cell's start edge, in the gap. The
// overlay ignores the pointer; only the handle takes it. With Bible columns
// the line is still the one before Target: Source and the Bibles share what
// Target leaves (editor-split.ts).
//
// Two grips, one control:
//   - in the rows, a thin 6px handle in the gap: the focusable separator, for
//     the mouse and the keyboard. Its layer sits beside the list's scroller,
//     not inside it, so a wheel turn over it is passed on to the scroller,
//     and on touch screens it takes no pointer input at all: a swipe over the
//     line scrolls the list as anywhere else.
//   - in the column-header row, portalled into the header grid, a grip that
//     widens to a finger-sized strip on touch screens. Nothing there scrolls
//     and nothing there is cut through.
//
// While dragging, only the line moves (a transform on the two grips). The
// two column variables on the table root are written once, on release: a
// variable on the root re-lays out every visible row, which is too much work
// per frame for an older iPad. No row re-renders either way, and
// MemoizedRow's props never change. Look and behaviour follow
// RightSidebarPanel's handle.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { EditorGridCols } from "@/lib/editor/editor-grid"
import {
  EDITOR_SPLIT_GAP_PX,
  applyEditorSplit,
  clampEditorSplit,
  editorSplitBounds,
  editorSplitFromPointer,
  editorSplitShares,
  editorSplitStep,
  readEditorSplit,
  writeEditorSplit,
} from "@/lib/editor/editor-split"

/** Two touches on the line this close together reset it (iOS may never send dblclick). */
const DOUBLE_TAP_MS = 400
const DOUBLE_TAP_PX = 24

function isRtl(el: Element): boolean {
  return el.closest("[dir]")?.getAttribute("dir") === "rtl"
}

const LINE_CLASS =
  "pointer-events-none h-full w-0.5 bg-muted-foreground/50 opacity-0 transition-opacity pointer-coarse:opacity-40"

export function EditorSplitDivider({
  rootRef,
  headerRef,
  scrollRef,
  gridCols,
  bibleTracks = 0,
}: {
  /** The table root, where the split variables are set. */
  rootRef: RefObject<HTMLElement | null>
  /** The column-header grid, which gets the header grip. */
  headerRef?: RefObject<HTMLElement | null>
  /** The list's scroll element, which a wheel turn over the line scrolls. */
  scrollRef?: RefObject<HTMLElement | null>
  gridCols: EditorGridCols | string
  /** Bible columns between Source and Target. */
  bibleTracks?: number
}) {
  const t = useT()
  const tracks = bibleTracks + 2
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const restRef = useRef<HTMLDivElement | null>(null)
  const targetRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<HTMLDivElement | null>(null)
  const gripRef = useRef<HTMLDivElement | null>(null)
  /** Ends the drag in progress; `commit: false` drops it. */
  const endDragRef = useRef<((commit: boolean) => void) | null>(null)
  const lastTapRef = useRef<{ at: number; x: number } | null>(null)
  /** What the person chose (null = today's split); kept even when it doesn't fit now. */
  const [saved, setSaved] = useState<number | null>(() => readEditorSplit())
  const [textWidth, setTextWidth] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    setHeaderEl(headerRef?.current ?? null)
  })

  const measure = useCallback(() => {
    const rest = restRef.current
    const target = targetRef.current
    if (!rest || !target) return
    // The rest cell spans Source and the Bible columns, gaps included.
    const restPx = rest.getBoundingClientRect().width - EDITOR_SPLIT_GAP_PX * bibleTracks
    setTextWidth(Math.max(0, restPx) + target.getBoundingClientRect().width)
  }, [bibleTracks])

  useLayoutEffect(() => {
    measure()
    const overlay = overlayRef.current
    if (!overlay || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => measure())
    observer.observe(overlay)
    return () => observer.disconnect()
  }, [measure])

  // Fallback: no saved split, or too narrow for the minimums → null, which
  // leaves the template's 1fr tracks (today's split). A saved split that no
  // longer fits is clamped here, not rewritten.
  const effective = clampEditorSplit(saved, textWidth, tracks)
  const bounds = editorSplitBounds(textWidth, tracks)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (root) applyEditorSplit(root, effective, tracks)
  }, [rootRef, effective, tracks])

  // The minimums stopped fitting mid-drag (window narrowed, Bible columns
  // came in): drop the drag rather than leave it half-done.
  useEffect(() => {
    if (!bounds) endDragRef.current?.(false)
  }, [bounds])

  const commit = useCallback((next: number | null) => {
    // Rounded as storage keeps it, so this visit and the next agree.
    const value = next === null ? null : Number(next.toFixed(4))
    setSaved(value)
    writeEditorSplit(value)
  }, [])

  const reset = useCallback(() => {
    endDragRef.current?.(false)
    commit(null)
  }, [commit])

  const setLineOffset = (px: number | null) => {
    for (const el of [handleRef.current, gripRef.current]) {
      if (el) el.style.transform = px === null ? "" : `translateX(${px}px)`
    }
  }

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      const target = targetRef.current
      if (!target || !bounds) return
      e.preventDefault()
      // Double tap: touch and pen get no reliable dblclick on iOS.
      if (e.pointerType !== "mouse") {
        const now = performance.now()
        const last = lastTapRef.current
        if (last && now - last.at < DOUBLE_TAP_MS && Math.abs(e.clientX - last.x) < DOUBLE_TAP_PX) {
          lastTapRef.current = null
          reset()
          return
        }
        lastTapRef.current = { at: now, x: e.clientX }
      }
      endDragRef.current?.(false)
      const handle = e.currentTarget
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {
        // jsdom / pointer already gone
      }
      const rtl = isRtl(handle)
      const rect = target.getBoundingClientRect()
      const targetEnd = rtl ? rect.left : rect.right
      const width = textWidth
      const start = effective ?? 1 / tracks
      let latest: number | null = null
      setDragging(true)

      const onMove = (ev: PointerEvent) => {
        latest = editorSplitFromPointer({ pointerX: ev.clientX, targetEnd, textWidth: width, tracks, rtl })
        // Target narrower → its start edge moves toward its end.
        setLineOffset(Math.round((start - latest) * width * (rtl ? -1 : 1) * 10) / 10)
      }
      const end = (commitDrag: boolean) => {
        if (endDragRef.current !== end) return
        endDragRef.current = null
        handle.removeEventListener("pointermove", onMove)
        handle.removeEventListener("pointerup", onUp)
        handle.removeEventListener("pointercancel", onUp)
        handle.removeEventListener("lostpointercapture", onUp)
        try {
          handle.releasePointerCapture(e.pointerId)
        } catch {
          // already released
        }
        setLineOffset(null)
        setDragging(false)
        if (commitDrag && latest !== null) commit(latest)
      }
      const onUp = () => end(true)
      endDragRef.current = end
      handle.addEventListener("pointermove", onMove)
      handle.addEventListener("pointerup", onUp)
      handle.addEventListener("pointercancel", onUp)
      handle.addEventListener("lostpointercapture", onUp)
    },
    [bounds, commit, effective, reset, textWidth, tracks],
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Home" || e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        reset()
        return
      }
      const next = editorSplitStep(effective, e.key, e.shiftKey, isRtl(e.currentTarget), textWidth, tracks)
      if (next === undefined) return
      e.preventDefault()
      e.stopPropagation()
      commit(next)
    },
    [commit, effective, reset, textWidth, tracks],
  )

  const onWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      const scroller = scrollRef?.current
      if (!scroller || typeof scroller.scrollBy !== "function") return
      // deltaMode: 0 pixels, 1 lines, 2 pages.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1
      scroller.scrollBy({ top: e.deltaY * unit, left: e.deltaX * unit })
    },
    [scrollRef],
  )

  const shares = editorSplitShares(effective, tracks)
  const percent = (n: number) => Math.round(n * 100)

  return (
    <div
      ref={overlayRef}
      aria-hidden={bounds ? undefined : true}
      data-testid="editor-split-overlay"
      className={cn(
        "pointer-events-none absolute inset-0 z-10 hidden gap-x-2 overflow-hidden ps-2.5 pe-4 [scrollbar-gutter:stable] md:grid",
        gridCols,
      )}
    >
      <div />
      <div ref={restRef} data-split-track="rest" style={{ gridColumn: `2 / span ${1 + bibleTracks}` }} />
      <div ref={targetRef} data-split-track="target" className="relative" style={{ gridColumn: 3 + bibleTracks }}>
        {bounds && (
          <div
            ref={handleRef}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("editor.column.resizeSplit")}
            aria-valuenow={percent(shares.target)}
            aria-valuemin={percent(bounds.min)}
            aria-valuemax={percent(bounds.max)}
            aria-valuetext={t("editor.column.splitValue", {
              source: percent(shares.rest),
              target: percent(shares.target),
            })}
            data-testid="editor-split-divider"
            data-separator={dragging ? "active" : undefined}
            tabIndex={0}
            className={cn(
              // Centred in the 8px gap before Target: -start-[7px] + w-1.5.
              "group/split pointer-events-auto absolute inset-y-0 -start-[7px] flex w-1.5 cursor-col-resize touch-pan-y items-stretch justify-center outline-none",
              // Touch drags use the header grip; a finger here scrolls the list.
              "pointer-coarse:pointer-events-none",
              "focus-visible:ring-1 focus-visible:ring-ring",
            )}
            onPointerDown={onPointerDown}
            onDoubleClick={reset}
            onKeyDown={onKeyDown}
            onWheel={onWheel}
          >
            <span
              aria-hidden
              className={cn(LINE_CLASS, "group-hover/split:opacity-100 group-focus-visible/split:opacity-100", dragging && "opacity-100")}
            />
          </div>
        )}
      </div>
      {bounds && headerEl && createPortal(
        // An absolutely positioned grid item: its box is the header's Target
        // track, so `-start-*` puts it in the gap before Target in LTR and RTL.
        <div
          ref={gripRef}
          aria-hidden
          data-testid="editor-split-header-grip"
          data-separator={dragging ? "active" : undefined}
          style={{ gridColumn: 3 + bibleTracks, gridRow: "1 / -1" }}
          className={cn(
            "group/split-grip absolute inset-y-0 -start-[7px] z-10 hidden w-1.5 cursor-col-resize touch-none justify-center md:flex",
            // Finger-sized on touch screens, still centred in the gap.
            "pointer-coarse:-start-[17px] pointer-coarse:w-[26px]",
          )}
          onPointerDown={onPointerDown}
          onDoubleClick={reset}
        >
          <span aria-hidden className={cn(LINE_CLASS, "group-hover/split-grip:opacity-100", dragging && "opacity-100")} />
        </div>,
        headerEl,
      )}
    </div>
  )
}
