import { useState } from "react"
import { X, Check, ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ChecklistState } from "@/hooks/useSetupChecklist"
import type { ProjectRecord } from "@/lib/parsers/types"
import { AiProviderStep } from "./checklist/AiProviderStep"
import { AiInstructionsStep } from "./checklist/AiInstructionsStep"
import { InviteStep } from "./checklist/InviteStep"
import { ComingSoonStep } from "./checklist/ComingSoonStep"

interface SetupChecklistDrawerProps {
  project: ProjectRecord
  state: ChecklistState
  onDismiss: () => void
  onClose: () => void
  onProjectUpdated: (p: ProjectRecord) => void
  onSharesChanged: () => void
}

function ChecklistItem({
  title,
  complete,
  children,
}: {
  title: string
  complete: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(!complete)

  return (
    <div className="rounded-lg border">
      <button
        className="flex w-full items-center gap-3 p-3 text-left text-sm font-medium hover:bg-accent/50"
        onClick={() => setOpen(!open)}
      >
        <div
          className={
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full " +
            (complete ? "bg-green-100 text-green-600" : "border border-muted-foreground/40")
          }
        >
          {complete && <Check className="h-3 w-3" />}
        </div>
        <span className="flex-1">{title}</span>
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {open && <div className="border-t px-3 pb-3 pt-2">{children}</div>}
    </div>
  )
}

export function SetupChecklistDrawer({
  project,
  state,
  onDismiss,
  onClose,
  onProjectUpdated,
  onSharesChanged,
}: SetupChecklistDrawerProps) {
  return (
    <div className="flex h-full w-80 flex-col border-l bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">Project Setup</h3>
          <p className="text-xs text-muted-foreground">
            {state.completedCount}/{state.totalCount} complete
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="h-6 w-6 p-0">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Checklist */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <ChecklistItem title="Choose AI provider" complete={state.aiProvider}>
          <AiProviderStep project={project} onUpdated={onProjectUpdated} />
        </ChecklistItem>

        <ChecklistItem title="Set AI instructions" complete={state.aiInstructions}>
          <AiInstructionsStep project={project} onUpdated={onProjectUpdated} />
        </ChecklistItem>

        <ChecklistItem title="Invite collaborators" complete={state.collaborators}>
          <InviteStep projectId={project.id} username={project.username || "anonymous"} onSharesChanged={onSharesChanged} />
        </ChecklistItem>

        <ComingSoonStep
          title="Upload project standards"
          description="Upload style guides and translation standards that AI will follow."
        />
        <ComingSoonStep
          title="Import glossary / translation memory"
          description="Import existing translation memories or glossaries to improve consistency."
        />
      </div>

      {/* Footer */}
      <div className="border-t p-4">
        <button
          onClick={onDismiss}
          className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Dismiss checklist
        </button>
      </div>
    </div>
  )
}
