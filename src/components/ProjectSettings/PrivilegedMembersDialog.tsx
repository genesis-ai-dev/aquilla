import { useEffect, useState } from "react"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  fetchPrivilegedProjectMembers,
  type ProjectMember,
} from "@/lib/frontier/members"
import { useT } from "@/lib/i18n/I18nProvider"
import { PERMISSION_DOCS_URL } from "@/components/PermissionDeniedAlert"

/**
 * GitHub "Workspace admins" modal: people who can change shared settings,
 * not the full roster. Opened from the per-control lock hint.
 */
export function PrivilegedMembersDialog({
  open,
  onOpenChange,
  projectId,
  roleLabel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
  roleLabel: string
}) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open || !projectId || !jwt) return
    let alive = true
    setLoading(true)
    setFailed(false)
    setMembers([])
    void fetchPrivilegedProjectMembers(jwt, projectId)
      .then((result) => {
        if (!alive) return
        if (result.kind === "ok") {
          setMembers(
            [...result.members].sort(
              (a, b) =>
                b.role.level - a.role.level || a.username.localeCompare(b.username),
            ),
          )
          setFailed(false)
        } else {
          setMembers([])
          setFailed(true)
        }
      })
      .catch(() => {
        if (!alive) return
        setMembers([])
        setFailed(true)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, projectId, jwt])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" aria-busy={loading || undefined}>
        <DialogHeader>
          <DialogTitle>
            {t("projectSettings.permission.privilegedDialogTitle", { role: roleLabel })}
          </DialogTitle>
          <DialogDescription>
            {t("projectSettings.permission.privilegedDialogDescription", { role: roleLabel })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="pb-1">
          {loading ? (
            <div className="flex items-center gap-2 py-3 text-muted-foreground">
              <Spinner />
              <span>{t("common.loading")}</span>
            </div>
          ) : failed ? (
            <p className="py-3 text-muted-foreground">
              {t("projectSettings.permission.privilegedDialogError", { role: roleLabel })}{" "}
              <a
                href={PERMISSION_DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {t("error.permissionDenied.learnMore")}
              </a>
            </p>
          ) : members.length === 0 ? (
            <p className="py-3 text-muted-foreground">
              {t("projectSettings.permission.privilegedDialogEmpty", { role: roleLabel })}
            </p>
          ) : (
            <ul className="flex flex-col">
              {members.map((member) => (
                <PrivilegedMemberRow key={member.userId} member={member} />
              ))}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function PrivilegedMemberRow({ member }: { member: ProjectMember }) {
  const email = member.email?.trim() || ""
  const showEmail = email.length > 0 && email.toLowerCase() !== member.username.toLowerCase()
  return (
    <li className="flex min-w-0 items-center gap-2.5 py-2">
      <span aria-hidden className="shrink-0">
        <InitialsAvatar name={member.username} size="sm" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground">{member.username}</span>
        {showEmail ? (
          <span className="block truncate text-muted-foreground">{email}</span>
        ) : null}
      </span>
    </li>
  )
}
