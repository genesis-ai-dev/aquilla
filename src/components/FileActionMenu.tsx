import { useEffect, useRef } from "react"
import { Pencil, FolderInput, Trash2, Download } from "lucide-react"

interface FileActionMenuProps {
  x: number
  y: number
  onClose: () => void
  onRename: () => void
  onMove: () => void
  onDelete: () => void
  /** Optional. Present only for file types we can export back to source
   *  format with round-trip fidelity (USFM today). */
  onExportSource?: () => void
}

export function FileActionMenu({
  x, y, onClose, onRename, onMove, onDelete, onExportSource,
}: FileActionMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent | KeyboardEvent) {
      if (e instanceof KeyboardEvent && e.key === "Escape") { onClose(); return }
      if (e instanceof MouseEvent && !ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", handler)
    document.addEventListener("keydown", handler)
    return () => {
      document.removeEventListener("mousedown", handler)
      document.removeEventListener("keydown", handler)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-40 w-44 rounded-md border bg-popover p-1 shadow-md text-sm"
      style={{ left: x, top: y }}
    >
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
        onClick={() => { onRename(); onClose() }}
      >
        <Pencil className="h-3.5 w-3.5" /> Rename
      </button>
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
        onClick={() => { onMove(); onClose() }}
      >
        <FolderInput className="h-3.5 w-3.5" /> Move to corpus…
      </button>
      {onExportSource && (
        <button
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
          onClick={() => { onExportSource(); onClose() }}
        >
          <Download className="h-3.5 w-3.5" /> Export source (.SFM)
        </button>
      )}
      <div className="my-1 h-px bg-border" />
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-destructive/10 text-destructive"
        onClick={() => { onDelete(); onClose() }}
      >
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </button>
    </div>
  )
}
