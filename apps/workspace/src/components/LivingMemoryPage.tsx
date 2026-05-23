// Phase 2c-gamma: Living Memory aggregated recent-validated examples by
// scanning per-file Y.Docs. With the Y.Doc rip that aggregation path is
// gone; rebuilding it on the cells projection is its own task, deferred
// to v1.x.

import { useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, Brain } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

export function LivingMemoryPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8">
      <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}`)}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to project
      </Button>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <Brain className="h-10 w-10 text-muted-foreground" />
          <div className="text-lg font-medium">Living Memory unavailable in this build</div>
          <p className="max-w-md text-sm text-muted-foreground">
            Recent-validated examples are paused while the storage layer is
            migrated off Y.Doc. They return in v1.x via the cells projection.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
