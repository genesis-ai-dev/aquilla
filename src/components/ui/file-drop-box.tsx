// A dashed box that really takes a dropped file, and lights up while one is
// over it, the way Upload files does (UploadPanel). Import map X-G-dead-drop
// (Nov 2, found by Sam on Source cues): the Sources dialogs drew the same
// dashed box but a dropped file did nothing, and only their button worked.

import { useState, type DragEvent, type ReactNode } from "react"
import { cn } from "@/lib/utils"

export function FileDropBox({ onFile, disabled, className, testId, children }: {
  /** The first dropped file. */
  onFile: (file: File) => void
  /** Takes no drops and never lights up (for example while a file is read). */
  disabled?: boolean
  className?: string
  testId?: string
  children: ReactNode
}) {
  const [over, setOver] = useState(false)
  const leave = (e: DragEvent<HTMLDivElement>) => {
    // Moving onto the box's own button or text is not leaving it.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setOver(false)
  }
  return (
    <div
      data-testid={testId}
      data-drag-over={over ? "true" : undefined}
      className={cn(
        "flex flex-col items-center rounded-lg border-2 border-dashed p-6 text-center transition-colors",
        over ? "border-primary bg-primary/5" : "border-muted",
        className,
      )}
      onDragOver={disabled ? undefined : (e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={disabled ? undefined : leave}
      onDrop={disabled ? undefined : (e) => {
        e.preventDefault()
        setOver(false)
        const file = e.dataTransfer.files?.[0]
        if (file) onFile(file)
      }}
    >
      {children}
    </div>
  )
}
