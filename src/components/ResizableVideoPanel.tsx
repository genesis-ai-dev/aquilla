import { useEffect, useRef, useState, type ReactNode } from "react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const STORAGE_KEY = "codex:video-height"
const DEFAULT_HEIGHT = 320
const MIN_HEIGHT = 120

interface ResizableVideoPanelProps {
  children: (height: number) => ReactNode
  className?: string
}

export function ResizableVideoPanel({ children, className }: ResizableVideoPanelProps) {
  const [height, setHeight] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) return Math.max(MIN_HEIGHT, parseInt(stored, 10))
    } catch {
      // ignore
    }
    return DEFAULT_HEIGHT
  })

  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null)

  function handleMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    dragStateRef.current = { startY: e.clientY, startHeight: height }
    document.body.style.cursor = "ns-resize"
    document.body.style.userSelect = "none"
  }

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      const state = dragStateRef.current
      if (!state) return
      const delta = e.clientY - state.startY
      const maxH = Math.floor(window.innerHeight * 0.7)
      const next = Math.max(MIN_HEIGHT, Math.min(maxH, state.startHeight + delta))
      setHeight(next)
    }
    function handleMouseUp() {
      if (!dragStateRef.current) return
      dragStateRef.current = null
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      try {
        localStorage.setItem(STORAGE_KEY, String(height))
      } catch {
        // ignore
      }
    }
    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)
    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
    }
  }, [height])

  return (
    <div className={cn("flex flex-col", className)}>
      {children(height)}
      <AppTooltip content="Drag to resize video">
        <div
          role="separator"
          onMouseDown={handleMouseDown}
          className={cn(
            "flex h-1.5 cursor-ns-resize items-center justify-center bg-border hover:bg-primary/30",
            dragStateRef.current ? "bg-primary/50" : ""
          )}
        >
          <div className="h-0.5 w-8 rounded-full bg-muted-foreground/40" />
        </div>
      </AppTooltip>
    </div>
  )
}
