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
import { UserChip } from "@/components/UserChip"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  fetchPrivilegedProjectMembers,
  type ProjectMember,
} from "@/lib/frontier/members"
import { ROLE, resolveRoleName } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"
import { PERMISSION_DOCS_URL } from "@/components/PermissionDeniedAlert"

/**
 * GitHub "Workspace admins" modal: people who can change a locked setting,
 * not the full roster. Opened from the per-control lock hint.
 *
 * AQU-2457: `minRole` is the floor of the section that opened it — the
 * dialog names that role and lists only members at it or above. A single
 * dialog serves every lock line, so it has to be told which one asked;
 * before this it always said (and listed) Maintainers, contradicting the
 * Languages and "Count headings" lines that name Project Leads.
 */
export function PrivilegedMembersDialog({
  open,
  onOpenChange,
  projectId,
  minRole = ROLE.MAINTAINER,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
  /** Role floor of the section that opened the dialog. */
  minRole?: number
}) {
  const t = useT()
  const roleLabel = resolveRoleName(t, minRole, { plural: true })
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
    void fetchPrivilegedProjectMembers(jwt, projectId, minRole)
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
  }, [open, projectId, jwt, minRole])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" aria-busy={loading || undefined}>
        <DialogHeader>
          {/* The role itself is the title. The old "Project {role}" template
              stuttered the moment the floor stopped always being Maintainer
              ("Project Project Leads"), in English and in every locale that
              appends the project noun. */}
          <DialogTitle>{roleLabel}</DialogTitle>
          <DialogDescription>
            {/* The lock line's own sentence, so the dialog cannot contradict
                it: "Only Project Leads can change these settings." reads true
                at every floor, where the Maintainer-shaped copy it replaced
                ("… members, and other project configuration") did not. */}
            {t("settings.locked.section", { role: roleLabel })}
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
      <UserChip userId={member.userId} username={member.username} size="sm" className="min-w-0" />
      {showEmail ? (
        <span className="min-w-0 truncate text-muted-foreground">{email}</span>
      ) : null}
    </li>
  )
}
