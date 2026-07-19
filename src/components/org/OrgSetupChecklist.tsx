import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { CheckCircle2, Circle, Users, X } from "lucide-react"
import { membersPath } from "@/lib/navigation/org-paths"
import { Button } from "@/components/ui/button"
import { ProjectCreateDialog } from "@/components/ProjectCreateDialog"
import { useOrgMembers } from "@/hooks/useOrg"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

const dismissKey = (orgId: number) => `org:setup:dismissed:${orgId}`

/**
 * Org-level onboarding checklist (Overview). The per-project SetupChecklist
 * gets one project ready; this gets the *organization* ready: create a first
 * project and bring a teammate in. Derived on read (no server state) and
 * dismissible per-org; hides itself once both steps are done. Complements the
 * zero-projects empty-state panel — this also nudges an org that has projects
 * but no teammates yet.
 */
export function OrgSetupChecklist({
  orgId,
  projectCount,
  onProjectCreated,
  linkableProjects,
}: {
  orgId: number
  projectCount: number
  onProjectCreated: (p: ProjectRecord) => void
  linkableProjects?: CloudProjectSummary[]
}) {
  const navigate = useNavigate()
  const { members } = useOrgMembers(orgId)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissKey(orgId)) === "1"
    } catch {
      return false
    }
  })

  const createdProject = projectCount > 0
  const invitedTeammate = members.length > 1
  const allDone = createdProject && invitedTeammate

  if (dismissed || allDone) return null

  function dismiss() {
    try {
      localStorage.setItem(dismissKey(orgId), "1")
    } catch {
      /* localStorage unavailable — dismiss for this session only */
    }
    setDismissed(true)
  }

  const doneCount = (createdProject ? 1 : 0) + (invitedTeammate ? 1 : 0)

  return (
    <section data-testid="org-setup-checklist" className="rounded-lg border bg-card p-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-medium">Get your organization started</h2>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss checklist"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{doneCount} of 2 complete</p>
      <ul className="space-y-3">
        <li className="flex items-center gap-3">
          {createdProject ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" aria-hidden />
          ) : (
            <Circle className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="flex-1 text-sm">Create your first project</span>
          {!createdProject && (
            <ProjectCreateDialog
              orgId={orgId}
              onCreated={onProjectCreated}
              linkableProjects={linkableProjects}
            />
          )}
        </li>
        <li className="flex items-center gap-3">
          {invitedTeammate ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" aria-hidden />
          ) : (
            <Circle className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="flex-1 text-sm">Invite a teammate to your organization</span>
          {!invitedTeammate && (
            <Button size="sm" variant="outline" onClick={() => navigate(membersPath(orgId))}>
              <Users className="mr-1.5 h-4 w-4" /> Invite
            </Button>
          )}
        </li>
      </ul>
    </section>
  )
}
