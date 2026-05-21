// Phase 2c-gamma: comments lived on per-file Y.Doc maps. The grammar for
// thread/message events is deferred to v1.x; the page renders a placeholder
// so the /project/:id/comments route still resolves.

import { useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, MessageCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

export function CommentsPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8">
      <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}`)}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to project
      </Button>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <MessageCircle className="h-10 w-10 text-muted-foreground" />
          <div className="text-lg font-medium">Comments unavailable in this build</div>
          <p className="max-w-md text-sm text-muted-foreground">
            Threaded comments are paused while the storage layer is migrated
            from per-file Y.Doc maps to the event-log. They return in v1.x.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
