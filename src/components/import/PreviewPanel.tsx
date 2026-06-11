/**
 * FRO-310: Preview panel — shows parsed cells before the upload is committed.
 *
 * Displayed between "file selected" and "upload starts". The user sees:
 *  - file name(s) + cell count(s)
 *  - first N cell snippets (original text + canonical ref when present)
 *  - Confirm button → triggers the actual bulk upload
 *  - Cancel button → returns to the upload screen without any network calls
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import type { ImportResult } from "@/lib/import"

export interface PreviewPanelProps {
  /** One entry per file; USFM may produce multiple results (one per book). */
  results: ImportResult[]
  /** Called when the user clicks Confirm — triggers the actual upload. */
  onConfirm: () => void | Promise<void>
  /** Called when the user cancels — parent returns to the upload screen. */
  onCancel: () => void
}

/** Max cells to show in the snippet list per result. */
const PREVIEW_LIMIT = 20

export function PreviewPanel({ results, onConfirm, onCancel }: PreviewPanelProps) {
  const [confirming, setConfirming] = useState(false)

  const totalCells = results.reduce((n, r) => n + r.strings.length, 0)

  async function handleConfirm() {
    if (confirming) return
    setConfirming(true)
    try {
      await onConfirm()
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <div>
        <p className="text-sm font-medium">
          Preview — {totalCells.toLocaleString()} cell{totalCells !== 1 ? "s" : ""} across {results.length} file{results.length !== 1 ? "s" : ""}
        </p>
        <p className="text-xs text-muted-foreground">
          Review what will be imported, then click Confirm to upload.
        </p>
      </div>

      {/* Native overflow scroll: ScrollArea's size-full viewport can't resolve
          against a max-h-only root, so content paints past the border. */}
      <div className="max-h-80 overflow-y-auto rounded-md border">
        <div className="divide-y">
          {results.map((r, ri) => (
            <div key={ri} className="p-3">
              <p className="mb-2 text-xs font-semibold text-foreground/80 uppercase tracking-wide">
                {r.name}
                <span className="ml-2 font-normal normal-case text-muted-foreground">
                  {r.strings.length.toLocaleString()} cells
                </span>
              </p>
              <ul className="space-y-1">
                {r.strings.slice(0, PREVIEW_LIMIT).map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    {s.globalReferences?.[0] ? (
                      <span className="shrink-0 font-mono text-muted-foreground w-20 truncate">
                        {s.globalReferences[0]}
                      </span>
                    ) : (
                      <span className="shrink-0 font-mono text-muted-foreground w-20 truncate">
                        {s.context || `#${i + 1}`}
                      </span>
                    )}
                    <span className="truncate text-foreground/80">
                      {s.original || <span className="italic text-muted-foreground">(empty)</span>}
                    </span>
                  </li>
                ))}
                {r.strings.length > PREVIEW_LIMIT && (
                  <li className="text-xs text-muted-foreground italic">
                    … and {(r.strings.length - PREVIEW_LIMIT).toLocaleString()} more
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={confirming}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleConfirm} disabled={confirming}>
          {confirming ? "Uploading…" : "Confirm import"}
        </Button>
      </div>
    </div>
  )
}
