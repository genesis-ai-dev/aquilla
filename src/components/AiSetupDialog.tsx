import { Sparkles } from "lucide-react"
import { useNavigate, useParams } from "react-router-dom"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { AiProviderStep } from "@/components/onboarding/checklist/AiProviderStep"
import type { ProjectRecord } from "@/lib/parsers/types"

interface AiSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
}

export function AiSetupDialog({ open, onOpenChange, project, onUpdated }: AiSetupDialogProps) {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Set up AI
          </DialogTitle>
          <DialogDescription>
            Choose a provider to enable translation suggestions.
          </DialogDescription>
        </DialogHeader>

        <AiProviderStep
          project={project}
          onUpdated={(p) => {
            onUpdated(p)
            onOpenChange(false)
          }}
        />

        <div className="text-center">
          <button
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              onOpenChange(false)
              navigate(`/project/${id}/settings`)
            }}
          >
            Full settings →
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
