import type { ProjectRecord } from "@/lib/parsers/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface ProjectCardProps {
  project: ProjectRecord
  onClick: () => void
}

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{project.name}</CardTitle>
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
