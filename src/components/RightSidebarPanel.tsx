import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { cn } from "@/lib/utils"

const DEFAULT_MIN_WIDTH = 240
const DEFAULT_MAX_WIDTH = 640

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function readStoredWidth(storageKey: string, fallback: number, min: number, max: number): number {
  try {
    const saved = localStorage.getItem(`right-sidebar-width:${storageKey}`)
    if (saved) {
      const n = parseInt(saved, 10)
      if (Number.isFinite(n)) return clamp(n, min, max)
    }
  } catch {
    // ignore
  }
  return clamp(fallback, min, max)
}

function writeStoredWidth(storageKey: string, width: number) {
  try {
    localStorage.setItem(`right-sidebar-width:${storageKey}`, String(Math.round(width)))
  } catch {
    // ignore
  }
}

export interface RightSidebarPanelProps {
  /** localStorage key under `right-sidebar-width:${storageKey}`. */
  storageKey: string
  defaultWidth: number
  minWidth?: number
  maxWidth?: number
  children: ReactNode
  className?: string
  /** Accessible name for the drag handle. */
  resizeLabel?: string
}

/**
 * Per-panel pixel-width shell for editor right-side drawers/sidebars.
 *
 * Each open panel owns its own width (and left-edge drag handle). We deliberately
 * do NOT nest a `ResizablePanelGroup` here — nesting under AppShell's left-dock
 * Group freezes the page via fighting ResizeObservers.
 */
export function RightSidebarPanel({
  storageKey,
  defaultWidth,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
  children,
  className,
  resizeLabel = "Resize panel",
}: RightSidebarPanelProps) {
  const [width, setWidth] = useState(() =>
    readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth),
  )
  const [dragging, setDragging] = useState(false)
  const widthRef = useRef(width)
  widthRef.current = width

  useEffect(() => {
    setWidth((w) => clamp(w, minWidth, maxWidth))
  }, [minWidth, maxWidth])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)
      const startX = e.clientX
      const startWidth = widthRef.current
      setDragging(true)

      const cleanup = (ev: PointerEvent) => {
        try {
          handle.releasePointerCapture(ev.pointerId)
        } catch {
          // jsdom / already released
        }
        handle.removeEventListener("pointermove", onMove)
        handle.removeEventListener("pointerup", onUp)
        handle.removeEventListener("pointercancel", onUp)
        setDragging(false)
      }

      const onMove = (ev: PointerEvent) => {
        // Left edge: drag left → wider, drag right → narrower.
        const next = clamp(startWidth + (startX - ev.clientX), minWidth, maxWidth)
        widthRef.current = next
        setWidth(next)
      }
      const onUp = (ev: PointerEvent) => {
        cleanup(ev)
        writeStoredWidth(storageKey, widthRef.current)
      }

      handle.addEventListener("pointermove", onMove)
      handle.addEventListener("pointerup", onUp)
      handle.addEventListener("pointercancel", onUp)
    },
    [maxWidth, minWidth, storageKey],
  )

  return (
    <div
      className={cn("relative flex h-full shrink-0 flex-col", className)}
      style={{ width }}
      data-slot="right-sidebar-panel"
      data-dragging={dragging ? "" : undefined}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={resizeLabel}
        aria-valuenow={Math.round(width)}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        data-slot="right-sidebar-resize-handle"
        data-separator={dragging ? "active" : undefined}
        tabIndex={0}
        className={cn(
          "group/aside-resize absolute inset-y-0 left-0 z-20 flex w-1.5 -translate-x-1/2 cursor-col-resize touch-none items-stretch justify-center outline-none",
          "focus-visible:ring-1 focus-visible:ring-ring",
        )}
        onPointerDown={onPointerDown}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 24 : 8
          if (e.key === "ArrowLeft") {
            e.preventDefault()
            const next = clamp(widthRef.current + step, minWidth, maxWidth)
            widthRef.current = next
            setWidth(next)
            writeStoredWidth(storageKey, next)
          } else if (e.key === "ArrowRight") {
            e.preventDefault()
            const next = clamp(widthRef.current - step, minWidth, maxWidth)
            widthRef.current = next
            setWidth(next)
            writeStoredWidth(storageKey, next)
          } else if (e.key === "Home") {
            e.preventDefault()
            widthRef.current = maxWidth
            setWidth(maxWidth)
            writeStoredWidth(storageKey, maxWidth)
          } else if (e.key === "End") {
            e.preventDefault()
            widthRef.current = minWidth
            setWidth(minWidth)
            writeStoredWidth(storageKey, minWidth)
          }
        }}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none h-full w-0.5 bg-muted-foreground/50 opacity-0 transition-opacity",
            "group-hover/aside-resize:opacity-100",
            dragging && "opacity-100",
          )}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  )
}
