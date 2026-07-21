/**
 * Dialog host for the file-scoped target import (FileTargetImportPanel):
 * populate the OPEN file's target column from USFM or a spreadsheet.
 * Opened from the workspace action menu ("Import translations into this file").
 */

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FileTargetImportPanel } from "@/components/import/FileTargetImportPanel"
import type { FileTargetCellRef } from "@/lib/import-file-target"
import posthog from "@/lib/posthog"
import { IMPORT_STARTED, IMPORT_SUCCEEDED, IMPORT_FAILED } from "@/lib/event-names"

export interface FileTargetImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  username: string
  fileName: string
  /** The open file's cells, in display order. */
  cells: FileTargetCellRef[]
  /** Mints a sync-token scoped to (projectId, fileId) for the commit upload. */
  getToken: (fileId: string) => Promise<string | null>
  /** Fired after commits land so the workspace can revalidate cells. */
  onImported: (committedCount: number) => void
  /** Optimistically patch many cells so the editor reflects imports immediately. */
  applyOptimisticTargetEdits: (patches: { cellId: string; value: string }[]) => void
}

export function FileTargetImportDialog({
  open,
  onOpenChange,
  projectId,
  username,
  fileName,
  cells,
  getToken,
  onImported,
  applyOptimisticTargetEdits,
}: FileTargetImportDialogProps) {
  // Remount the panel each time the dialog opens so a previous run's step
  // state never leaks into the next one.
  const [panelKey, setPanelKey] = useState(0)
  useEffect(() => {
    if (open) {
      setPanelKey((k) => k + 1)
      posthog.capture(IMPORT_STARTED, { import_type: "file-target", project_id: projectId })
    }
  }, [open, projectId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import translations</DialogTitle>
        </DialogHeader>
        {/* The panel owns its own header / scroll / footer layout; give it the
            full remaining height so its review step can pin the footer. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <FileTargetImportPanel
            key={panelKey}
            projectId={projectId}
            username={username}
            fileName={fileName}
            cells={cells}
            getToken={getToken}
            applyOptimisticTargetEdits={applyOptimisticTargetEdits}
            onImported={(committedCount) => {
              posthog.capture(IMPORT_SUCCEEDED, {
                import_type: "file-target",
                file_count: committedCount,
                project_id: projectId,
              })
              onImported(committedCount)
              onOpenChange(false)
            }}
            onError={(message, phase) => {
              posthog.capture(IMPORT_FAILED, {
                import_type: "file-target",
                phase,
                project_id: projectId,
                error: message,
              })
            }}
            onCancel={() => onOpenChange(false)}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
