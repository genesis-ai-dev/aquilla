import { useState } from "react"
import { Check, ChevronDown, ChevronRight } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import type { ChecklistState } from "@/hooks/useSetupChecklist"
import type { ProjectRecord } from "@/lib/parsers/types"
import { AiProviderStep } from "./checklist/AiProviderStep"
import { AiInstructionsStep } from "./checklist/AiInstructionsStep"
import { InviteStep } from "./checklist/InviteStep"
import { ComingSoonStep } from "./checklist/ComingSoonStep"
import { AiModelsStep } from "./checklist/AiModelsStep"

interface SetupChecklistDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: ProjectRecord
  state: ChecklistState
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
        aria-expanded={open}
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
  open,
  onOpenChange,
  project,
  state,
  onProjectUpdated,
  onSharesChanged,
}: SetupChecklistDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-96">
        <SheetHeader>
          <SheetTitle>Project Setup</SheetTitle>
          <SheetDescription>
            {state.completedCount}/{state.totalCount} complete
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          <ChecklistItem title="Choose AI provider" complete={state.aiProvider}>
            <AiProviderStep project={project} onUpdated={onProjectUpdated} />
          </ChecklistItem>

          <ChecklistItem title="Set AI instructions" complete={state.aiInstructions}>
            <AiInstructionsStep project={project} onUpdated={onProjectUpdated} />
          </ChecklistItem>

          <ChecklistItem title="Invite collaborators" complete={state.collaborators}>
            <InviteStep projectId={project.id} username={project.username || "anonymous"} onSharesChanged={onSharesChanged} />
          </ChecklistItem>

          <ChecklistItem title="Enable AI voice & transcription" complete={state.aiModels}>
            <AiModelsStep />
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
      </SheetContent>
    </Sheet>
  )
}
