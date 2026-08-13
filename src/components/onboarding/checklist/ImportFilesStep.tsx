import { Button } from "@/components/ui/button"
import type { ProjectRecord } from "@/lib/parsers/types"

interface ImportFilesStepProps {
  project: ProjectRecord
  /** Called when the user clicks the import button. The parent (ProjectWorkspace)
   *  owns the real ImportDialog and handles the file-import flow. */
  onOpenImport: () => void
}

export function ImportFilesStep({ project, onOpenImport }: ImportFilesStepProps) {
  const fileCount = project.files?.length ?? 0

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Import your source text first — USFM, plain text, or other supported
        formats. Everything else (AI suggestions, voice, and collaboration) works
        on specific files, so importing first sets you up for success.
      </p>

      {fileCount > 0 && (
        <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
          {fileCount} file{fileCount === 1 ? "" : "s"} imported
        </p>
      )}

      <Button className="w-full" onClick={onOpenImport}>
        {fileCount > 0 ? "Import more files" : "Import files"}
      </Button>
    </div>
  )
}
