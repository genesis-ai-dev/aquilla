import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { AddProjectMemberDialog } from "@/components/ProjectSettings/AddProjectMemberDialog"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { useProjectScopePath } from "@/hooks/useProjectScopePath"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { callerLevelFromRoster } from "@/lib/frontier/member-grants"
import { useT } from "@/lib/i18n/I18nProvider"

interface InviteStepProps {
  projectId: string
  onSharesChanged: () => void
  /** Lets the parent sheet ignore overlay clicks while this dialog is open. */
  onDialogOpenChange?: (open: boolean) => void
}

/**
 * Opens the same Add-member dialog as project settings, nested over the
 * setup sheet — not a one-off inline invite form.
 */
export function InviteStep({
  projectId,
  onSharesChanged,
  onDialogOpenChange,
}: InviteStepProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const { members, addMany } = useProjectMembers(projectId)
  // AQU-1352 §3.9: the dialog header names the scope ("Add people to Org › Project")
  // once it is known; the dialog falls back to its generic title until then.
  const scopePath = useProjectScopePath(projectId)
  const { session } = useFrontierSession()
  // AQU-853: same cap as the settings Members pane — the role picker must not
  // offer a grant above the caller's own role.
  const callerLevel = useMemo(
    () => callerLevelFromRoster(members, session?.username),
    [members, session?.username],
  )

  function handleOpenChange(next: boolean) {
    setOpen(next)
    onDialogOpenChange?.(next)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t("projectSettings.members.addDialogDescription")}
      </p>
      <Button size="sm" className="w-full" onClick={() => handleOpenChange(true)}>
        {t("org.membersPage.orgTable.addMemberTitle")}
      </Button>
      <AddProjectMemberDialog
        projectId={projectId}
        open={open}
        onOpenChange={handleOpenChange}
        members={members}
        addMany={addMany}
        scopePath={scopePath}
        onAdded={onSharesChanged}
        callerLevel={callerLevel}
      />
    </div>
  )
}
