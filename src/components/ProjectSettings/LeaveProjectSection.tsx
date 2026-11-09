// Project settings — "Leave project" (AQU-1993).
//
// The one control on this page a person uses on their own behalf rather than
// on the project's: it gives up their own direct grant. It sits in the
// always-visible General pane, NOT in the Members pane, because the member
// list can be walled off by the organization's view policy — and the person
// who most needs a way out (someone invited to a project they no longer want)
// is exactly the one that policy hides it from.
//
// Access inherited from the organization, a team, or being the project's
// creator is not the caller's to drop, so the server reports what survived
// and this row says so instead of implying the project is gone.

import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldError } from "@/components/ui/field"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { toast } from "@/components/ui/toast"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { leaveProject, NoDirectMembershipError } from "@/lib/frontier/members"
import { useT } from "@/lib/i18n/I18nProvider"

export function LeaveProjectSection({
  projectId,
  projectName,
}: {
  projectId: string
  projectName: string
}) {
  const t = useT()
  const navigate = useNavigate()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleLeave() {
    if (!jwt) return
    setLeaving(true)
    setError(null)
    try {
      const result = await leaveProject(jwt, projectId)
      setConfirmOpen(false)
      if (result.stillHasAccess) {
        toast.add({
          type: "info",
          title: t("projectSettings.leave.stillHasAccess"),
        })
        return
      }
      toast.add({ type: "success", title: t("projectSettings.leave.leftToast", { name: projectName }) })
      navigate("/")
    } catch (err) {
      // Close first: the refusal is explained on the row, and an open dialog
      // would hide that message from assistive technology behind its own
      // aria-hidden backdrop.
      setConfirmOpen(false)
      setError(
        err instanceof NoDirectMembershipError
          ? t("projectSettings.leave.inheritedOnly")
          : t("projectSettings.leave.failed"),
      )
    } finally {
      setLeaving(false)
    }
  }

  return (
    <SettingsGroup label={t("settings.teamSettings.dangerZoneLabel")}>
      <SettingsRow
        label={t("projectSettings.leave.rowLabel")}
        description={t("projectSettings.leave.rowDescription")}
        control={
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              setError(null)
              setConfirmOpen(true)
            }}
          >
            {t("projectSettings.leave.rowLabel")}
          </Button>
        }
      />
      {error ? <FieldError role="alert">{error}</FieldError> : null}

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("projectSettings.leave.confirmTitle", { name: projectName })}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("projectSettings.leave.confirmBody")}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={leaving}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                void handleLeave()
              }}
              disabled={leaving}
            >
              {leaving ? t("projectSettings.leave.leavingButton") : t("projectSettings.leave.rowLabel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  )
}
