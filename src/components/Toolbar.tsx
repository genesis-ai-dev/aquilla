import { Button } from "@/components/ui/button"
import type { ProjectRecord } from "@/lib/parsers/types"

interface ToolbarProps {
  project: ProjectRecord
  onBack: () => void
  onImport: () => void
}

export function Toolbar({ project, onBack, onImport }: ToolbarProps) {
  return (
    <header className="flex items-center gap-4 border-b px-4 py-2">
      <Button variant="ghost" size="sm" onClick={onBack}>
        ← Back
      </Button>
      <h2 className="font-semibold">{project.name}</h2>
      <span className="text-sm text-muted-foreground">
        {project.sourceLanguage} → {project.targetLanguage}
      </span>
      <div className="flex-1" />
      <Button size="sm" onClick={onImport}>
        + Import
      </Button>
    </header>
  )
}
