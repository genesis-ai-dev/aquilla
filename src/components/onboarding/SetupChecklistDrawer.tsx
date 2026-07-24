import { useEffect, useRef } from "react"
import { CheckCircle2, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import posthog from "@/lib/posthog"
import { SETUP_CHECKLIST_COMPLETED } from "@/lib/event-names"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import type { ChecklistState } from "@/hooks/useSetupChecklist"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"
import { ChecklistItem } from "./checklist/ChecklistItem"
import { ImportFilesStep } from "./checklist/ImportFilesStep"
import { AiInstructionsStep } from "./checklist/AiInstructionsStep"
import { InviteStep } from "./checklist/InviteStep"
import { ComingSoonStep } from "./checklist/ComingSoonStep"
import { AiModelsStep } from "./checklist/AiModelsStep"
import { RoleGatedStep } from "./checklist/RoleGatedStep"

interface SetupChecklistDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: ProjectRecord
  /**
   * AQU-334: caller's resolved project role, fresh from this load's
   * `useProject` resolve (`roleLevel`, NOT `project.syncRole?.level`).
   * `project.syncRole` is an intentionally stale-tolerant cache (see its doc
   * comment) stamped by unrelated /sync-token round-trips elsewhere in the
   * workspace — using it here let a real contributor's checklist render with
   * `roleLevel == null` (fail-open) whenever that cache hadn't been stamped
   * yet for this session, showing every step as editable regardless of role.
   * null here means the project genuinely hasn't resolved a server role
   * (unsynced/local-only project) — every step stays editable (see
   * RoleGatedStep doc comment).
   */
  roleLevel: number | null
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
  roleLevel,
  state,
  onProjectUpdated,
  onSharesChanged,
  onDismiss,
  onOpenImport,
}: SetupChecklistDrawerProps) {
  const allDone = state.completedCount === state.totalCount && state.totalCount > 0
  const progress = state.totalCount === 0 ? 0 : state.completedCount / state.totalCount

  // Activation milestone: fire once when the checklist first reaches 100%.
  // Consent-gated at the posthog module level.
  const completionFired = useRef(false)
  useEffect(() => {
    if (allDone && !completionFired.current) {
      completionFired.current = true
      posthog.capture(SETUP_CHECKLIST_COMPLETED, { project_id: project.id })
    }
  }, [allDone, project.id])

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
                // AQU-693: launching the import dialog from step 1 must NOT
                // count as a dismissal. Calling onOpenChange(false) here routed
                // through the workspace's close handler, which persists the
                // `setupChecklistDismissed` flag — silently ending the whole
                // setup flow the moment the user used step 1 as intended. The
                // parent (ProjectWorkspace) now owns hiding the drawer while the
                // import dialog is on top and reopening it afterwards, without
                // ever recording a dismissal.
                onOpenImport?.()
              }}
            />
          </ChecklistItem>

          <ChecklistItem
            title="Set translation instructions"
            description="A short system prompt that shapes tone, formality, and style. Shared with everyone in this project."
            complete={state.aiInstructions}
          >
            <RoleGatedStep
              roleLevel={roleLevel}
              requiredRole={ROLE.MAINTAINER}
              actionLabel="Editing translation instructions"
            >
              <AiInstructionsStep project={project} onUpdated={onProjectUpdated} />
            </RoleGatedStep>
          </ChecklistItem>

          <ChecklistItem
            title="Invite collaborators"
            description="Translators and reviewers join with the same permissions you choose."
            complete={state.collaborators}
          >
            <RoleGatedStep
              roleLevel={roleLevel}
              requiredRole={ROLE.PROJECT_LEAD}
              actionLabel="Inviting collaborators"
            >
              <InviteStep
                projectId={project.id}
                onSharesChanged={onSharesChanged}
              />
            </RoleGatedStep>
          </ChecklistItem>

          <ChecklistItem
            title="Configure voice & transcription"
            description="Gemini TTS is recommended for voice; Whisper transcription runs locally."
            complete={state.aiModels}
          >
            <RoleGatedStep
              roleLevel={roleLevel}
              requiredRole={ROLE.MAINTAINER}
              actionLabel="Configuring voice and transcription"
            >
              <AiModelsStep project={project} onUpdated={onProjectUpdated} />
            </RoleGatedStep>
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
