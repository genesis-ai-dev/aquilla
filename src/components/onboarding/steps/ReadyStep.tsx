import { Button } from "@/components/ui/button"
import { Check } from "lucide-react"
import type { ProjectRecord } from "@/lib/parsers/types"

export function ReadyStep({
  project,
  onFinish,
}: {
  project: ProjectRecord
  onFinish: () => void
}) {
  return (
    <div className="space-y-6 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-lg bg-green-100 text-green-600">
        <Check className="h-8 w-8" />
      </div>
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">You're all set!</h2>
        <p className="text-muted-foreground">
          <strong>{project.name}</strong> is ready. We'll walk you through setting up AI and inviting collaborators next.
        </p>
      </div>
      <Button size="lg" onClick={onFinish} className="w-full">
        Start Translating
      </Button>
    </div>
  )
}
