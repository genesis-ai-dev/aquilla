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
import { useT } from "@/lib/i18n/I18nProvider"

interface AiSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
}

export function AiSetupDialog({ open, onOpenChange, project, onUpdated }: AiSetupDialogProps) {
  const t = useT()
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {t("workspace.aiSetup.title")}
          </DialogTitle>
          <DialogDescription>
            {t("workspace.aiSetup.description")}
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
            {t("workspace.aiSetup.fullSettingsLink")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
