// Phase 2c-gamma: snapshots serialised a Y.Doc state vector + per-file
// rich text. With the Y.Doc rip the snapshot-create / restore / export
// pipeline has no source-of-truth to read from. The route still resolves
// to keep navigation links intact; the actual feature returns in v1.x
// once snapshots become event-log replays.

import { useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, Camera } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

export function SnapshotsPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8">
      <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}`)}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to project
      </Button>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <Camera className="h-10 w-10 text-muted-foreground" />
          <div className="text-lg font-medium">Snapshots unavailable in this build</div>
          <p className="max-w-md text-sm text-muted-foreground">
            Project snapshots are paused while the storage layer is migrated
            off Y.Doc. They return in v1.x as event-log replays.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
