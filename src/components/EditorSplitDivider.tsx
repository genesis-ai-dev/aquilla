// AQU-2678 (ETEN): the draggable line between the line table's Source and
// Target columns.
//
// It lives in an overlay grid laid over the rows with the rows' own template,
// padding and scrollbar gutter (the same trick the column headings use,
// AQU-2288), so its Source cell IS the Source track in LTR and RTL alike and
// the handle simply sits on that cell's end edge, in the gap. The overlay
// ignores the pointer; only the handle takes it.
//
// Dragging writes two CSS variables on the table root and nothing else: the
// rows and headers read them through their template, so no row re-renders
// and MemoizedRow's props do not change. Only this small component renders
// (for its aria value). Look and behaviour follow RightSidebarPanel's handle.

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { EditorGridCols } from "@/lib/editor/editor-grid"
import {
  applyEditorSplit,
  clampEditorSplit,
  editorSplitBounds,
  editorSplitFromPointer,
  editorSplitStep,
  readEditorSplit,
  writeEditorSplit,
} from "@/lib/editor/editor-split"

function isRtl(el: Element): boolean {
  return el.closest("[dir]")?.getAttribute("dir") === "rtl"
}

export function EditorSplitDivider({
  rootRef,
  gridCols,
}: {
  /** The table root, where the split variables are set. */
  rootRef: RefObject<HTMLElement | null>
  gridCols: EditorGridCols | string
}) {
  const t = useT()
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const sourceRef = useRef<HTMLDivElement | null>(null)
  const targetRef = useRef<HTMLDivElement | null>(null)
  /** What the person chose (null = today's split); kept even when it doesn't fit now. */
  const [saved, setSaved] = useState<number | null>(() => readEditorSplit())
  /** The split shown mid-drag, before it is saved on release. */
  const [live, setLive] = useState<number | null>(null)
  const [textWidth, setTextWidth] = useState(0)
  const [dragging, setDragging] = useState(false)

  const measure = useCallback(() => {
    const source = sourceRef.current
    const target = targetRef.current
    if (!source || !target) return
    setTextWidth(source.getBoundingClientRect().width + target.getBoundingClientRect().width)
  }, [])

  useLayoutEffect(() => {
    measure()
    const overlay = overlayRef.current
    if (!overlay || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => measure())
    observer.observe(overlay)
    return () => observer.disconnect()
  }, [measure])

  // Fallback: no saved split, or too narrow for both minimums → null, which
  // leaves the template's 1fr tracks (today's split). A saved split that no
  // longer fits is clamped here, not rewritten.
  const effective = clampEditorSplit(live ?? saved, textWidth)
  const bounds = editorSplitBounds(textWidth)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (root) applyEditorSplit(root, effective)
  }, [rootRef, effective])

  const commit = useCallback((next: number | null) => {
    setLive(null)
    setSaved(next)
    writeEditorSplit(next)
  }, [])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      const source = sourceRef.current
      if (!source || textWidth <= 0) return
      e.preventDefault()
      const handle = e.currentTarget
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {
        // jsdom / pointer already gone
      }
      const rtl = isRtl(handle)
      const rect = source.getBoundingClientRect()
      const sourceStart = rtl ? rect.right : rect.left
      const width = textWidth
      let latest: number | null = null
      setDragging(true)

      const onMove = (ev: PointerEvent) => {
        latest = editorSplitFromPointer({ pointerX: ev.clientX, sourceStart, textWidth: width, rtl })
        setLive(latest)
      }
      const onUp = (ev: PointerEvent) => {
        try {
          handle.releasePointerCapture(ev.pointerId)
        } catch {
          // already released
        }
        handle.removeEventListener("pointermove", onMove)
        handle.removeEventListener("pointerup", onUp)
        handle.removeEventListener("pointercancel", onUp)
        setDragging(false)
        if (latest !== null) commit(latest)
        else setLive(null)
      }
      handle.addEventListener("pointermove", onMove)
      handle.addEventListener("pointerup", onUp)
      handle.addEventListener("pointercancel", onUp)
    },
    [commit, textWidth],
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Home" || e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        commit(null)
        return
      }
      const next = editorSplitStep(effective, e.key, e.shiftKey, isRtl(e.currentTarget), textWidth)
      if (next === undefined) return
      e.preventDefault()
      e.stopPropagation()
      commit(next)
    },
    [commit, effective, textWidth],
  )

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
      <div ref={sourceRef} data-split-track="source" className="relative">
        {bounds && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("editor.column.resizeSplit")}
            aria-valuenow={Math.round((effective ?? 0.5) * 100)}
            aria-valuemin={Math.round(bounds.min * 100)}
            aria-valuemax={Math.round(bounds.max * 100)}
            data-testid="editor-split-divider"
            data-separator={dragging ? "active" : undefined}
            tabIndex={0}
            className={cn(
              // Centred in the 8px gap after Source: -end-[7px] + w-1.5.
              "group/split pointer-events-auto absolute inset-y-0 -end-[7px] flex w-1.5 cursor-col-resize touch-none items-stretch justify-center outline-none",
              "focus-visible:ring-1 focus-visible:ring-ring",
              // A wider invisible grab area for fingers.
              "before:absolute before:inset-y-0 before:-inset-x-2.5 before:content-[''] pointer-fine:before:hidden",
            )}
            onPointerDown={onPointerDown}
            onDoubleClick={() => commit(null)}
            onKeyDown={onKeyDown}
          >
            <span
              aria-hidden
              className={cn(
                "pointer-events-none h-full w-0.5 bg-muted-foreground/50 opacity-0 transition-opacity",
                "group-hover/split:opacity-100 group-focus-visible/split:opacity-100",
                dragging && "opacity-100",
              )}
            />
          </div>
        )}
      </div>
      <div ref={targetRef} data-split-track="target" />
    </div>
  )
}
