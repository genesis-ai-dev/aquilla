import { GitBranch } from "lucide-react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface ProjectCardProps {
  project: ProjectRecord
  onClick: () => void
}

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const isGit = project.origin?.kind === "git"
  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-lg">{project.name}</CardTitle>
          {isGit && (
            <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <GitBranch className="h-3 w-3" /> git
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {project.sourceLanguage} → {project.targetLanguage}
        </p>
        <p className="text-sm text-muted-foreground">
          {project.files.length} file{project.files.length !== 1 ? "s" : ""}
        </p>
      </CardContent>
    </Card>
  )
}
