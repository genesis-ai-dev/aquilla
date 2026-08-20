import { Button } from "@/components/ui/button"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"

interface ImportFilesStepProps {
  project: ProjectRecord
  /** Called when the user clicks the import button. The parent (ProjectWorkspace)
   *  owns the real ImportDialog and handles the file-import flow. */
  onOpenImport: () => void
}

export function ImportFilesStep({ project, onOpenImport }: ImportFilesStepProps) {
  const t = useT()
  const fileCount = project.files?.length ?? 0

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t("onboarding.checklist.importFiles.description")}
      </p>

      {fileCount > 0 && (
        <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
          {t("onboarding.checklist.importFiles.countImported", { count: fileCount })}
        </p>
      )}

      <Button size="sm" className="w-full" onClick={onOpenImport}>
        {fileCount > 0 ? t("onboarding.checklist.importFiles.importMore") : t("onboarding.checklist.importFiles.title")}
      </Button>
    </div>
  )
}
