import { useCallback, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { importFile } from "@/lib/import"
import type { FileReference } from "@/lib/parsers/types"

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceLanguage: string
  targetLanguage: string
  onImported: (refs: FileReference[]) => void
}

export function ImportDialog({
  open,
  onOpenChange,
  sourceLanguage,
  targetLanguage,
  onImported,
}: ImportDialogProps) {
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setImporting(true)
      setError(null)
      const allRefs: FileReference[] = []

      try {
        for (const file of Array.from(files)) {
          const refs = await importFile(file, sourceLanguage, targetLanguage)
          allRefs.push(...refs)
        }
        onImported(allRefs)
        onOpenChange(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed")
      } finally {
        setImporting(false)
      }
    },
    [sourceLanguage, targetLanguage, onImported, onOpenChange]
  )

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import Files</DialogTitle>
        </DialogHeader>
        <div
          className={cn(
            "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors",
            dragOver ? "border-primary bg-primary/5" : "border-muted"
          )}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {importing ? (
            <p className="text-sm text-muted-foreground">Importing...</p>
          ) : (
            <>
              <p className="mb-2 text-sm text-muted-foreground">
                Drag & drop files here, or
              </p>
              <Button variant="outline" size="sm" render={<label className="cursor-pointer" />}>
                Choose Files
                <input
                  type="file"
                  multiple
                  className="hidden"
                  accept=".md,.markdown,.docx,.pptx,.txt,.vtt,.srt,.usfm,.sfm"
                  onChange={handleFileInput}
                />
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">
                Supported: MD, DOCX, PPTX, TXT, VTT, SRT, USFM
              </p>
            </>
          )}
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
