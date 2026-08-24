import { useState } from "react"
import { Button } from "@/components/ui/button"
import { AddProjectMemberDialog } from "@/components/ProjectSettings/AddProjectMemberDialog"
import { useProjectMembers } from "@/hooks/useProjectMembers"
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
        onAdded={onSharesChanged}
      />
    </div>
  )
}
