import { CheckCircle2, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import type { ChecklistState } from "@/hooks/useSetupChecklist"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ChecklistItem } from "./checklist/ChecklistItem"
import { ImportFilesStep } from "./checklist/ImportFilesStep"
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
  /** Persist dismissal and close the drawer. Surfaced as "All set" when 100%. */
  onDismiss: () => void
  /** Opens the project's import dialog (owned by the parent). Required to
   *  power the "Import files" first step. */
  onOpenImport?: () => void
}

export function SetupChecklistDrawer({
  open,
  onOpenChange,
  project,
  state,
  onProjectUpdated,
  onSharesChanged,
  onDismiss,
  onOpenImport,
}: SetupChecklistDrawerProps) {
  const allDone = state.completedCount === state.totalCount && state.totalCount > 0
  const progress = state.totalCount === 0 ? 0 : state.completedCount / state.totalCount

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[28rem] flex-col">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden />
            Project setup
          </SheetTitle>
          <SheetDescription>
            A few quick steps so AI suggestions, voice, and collaboration are
            ready before you dive in.
          </SheetDescription>
          <ProgressBar value={progress} />
          <p className="text-xs text-muted-foreground">
            {state.completedCount} of {state.totalCount} complete
          </p>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          <ChecklistItem
            title="Import files"
            description="Bring in your source text first — USFM, plain text, or other supported formats. Everything else works on specific files."
            complete={state.importFiles}
          >
            <ImportFilesStep
              project={project}
              onOpenImport={() => {
                onOpenChange(false)
                onOpenImport?.()
              }}
            />
          </ChecklistItem>

          <ChecklistItem
            title="Set translation instructions"
            description="A short system prompt that shapes tone, formality, and style. Shared with everyone in this project."
            complete={state.aiInstructions}
          >
            <AiInstructionsStep project={project} onUpdated={onProjectUpdated} />
          </ChecklistItem>

          <ChecklistItem
            title="Invite collaborators"
            description="Translators and reviewers join with the same permissions you choose."
            complete={state.collaborators}
          >
            <InviteStep
              projectId={project.id}
              onSharesChanged={onSharesChanged}
            />
          </ChecklistItem>

          <ChecklistItem
            title="Configure voice & transcription"
            description="Gemini TTS is recommended for voice; Whisper transcription runs locally."
            complete={state.aiModels}
          >
            <AiModelsStep project={project} onUpdated={onProjectUpdated} />
          </ChecklistItem>

          <ComingSoonStep
            title="Upload project standards"
            description="Style guides and translation standards the AI will follow."
          />
          <ComingSoonStep
            title="Import glossary / translation memory"
            description="Existing TM or glossaries to keep terminology consistent."
          />
        </div>

        <div className="border-t bg-card/40 p-4">
          {allDone ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                You're all set
              </div>
              <p className="text-xs text-muted-foreground">
                You can reopen this checklist any time from the project header.
              </p>
              <Button onClick={onDismiss} className="w-full">
                Hide checklist and start translating
              </Button>
            </div>
          ) : (
            <Button variant="ghost" onClick={onDismiss} className="w-full">
              Skip for now
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value))
  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuenow={Math.round(pct * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full bg-primary transition-[width] duration-200"
        style={{ width: `${pct * 100}%` }}
      />
    </div>
  )
}
