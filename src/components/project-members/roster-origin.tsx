/**
 * AQU-1352 §3.7 rules 1–5 for the project roster: map the members payload's
 * server-derived origin fields onto the shared access primitives, and the
 * rule-4 remove dialog. The client never recomputes inheritance — every
 * origin here comes from the server (`effective`/`direct`/`inheritedFrom`/
 * `afterDirectRemoval`), falling back to legacy `role.source` only when an
 * older payload lacks them.
 *
 * SWARM-TODO(AQU-1352): TeamDetail and OrgMembersTable rows do not yet render
 * GrantOriginBadge/InheritedRoleControl (team rows with NULL role_level
 * inherit from the org; org rows are always direct). Needs an origin field
 * on the team members payload first.
 */
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { roleLabel } from "@/components/access/labels"
import { formatScopePath } from "@/lib/access/scope-path"
import type { GrantOrigin, ScopeRef } from "@/lib/access/types"
import type { ProjectMember } from "@/lib/frontier/members"
import { useT } from "@/lib/i18n/I18nProvider"

/** Rule 1: the origin of the member's effective role on this project. */
export function memberOrigin(m: ProjectMember): GrantOrigin {
  const source = m.effective?.source ?? m.role.source
  switch (source) {
    case "override":
      return { kind: "direct" }
    case "creator":
      return { kind: "creator" }
    case "platform":
      return { kind: "platform" }
    default:
      return { kind: "inherited", from: m.inheritedFrom ?? undefined }
  }
}

/** Direct role on this project, or null when the member holds none. */
export function memberDirectLevel(m: ProjectMember): number | null {
  if (m.direct !== undefined) return m.direct
  if (m.role.source === "override") return m.role.level
  return m.secondarySources?.find((s) => s.source === "override")?.level ?? null
}

/** Rule 2: read-only in place when the role comes from an ancestor with no direct grant here. */
export function isInheritedOnly(m: ProjectMember): boolean {
  return memberOrigin(m).kind === "inherited" && memberDirectLevel(m) == null
}

/** Link to the scope page where an inherited grant lives. */
export function scopeHref(scope: ScopeRef, orgId: string | null): string | undefined {
  if (scope.type === "org") return `/orgs/${scope.id}/members`
  if (scope.type === "team" && orgId) return `/orgs/${orgId}/teams/${scope.id}`
  return undefined
}

/** Rule 5: members with a grant on this project vs. those reaching it from above. */
export function countBreakdown(members: ProjectMember[]): { direct: number; inherited: number } {
  let direct = 0
  for (const m of members) {
    const kind = memberOrigin(m).kind
    if (memberDirectLevel(m) != null || kind === "creator" || kind === "platform") direct++
  }
  return { direct, inherited: members.length - direct }
}

/**
 * Rule 4: removing a direct grant. When the server's dry-run says access
 * survives through a team/org grant, the dialog says so and offers a link to
 * that scope — a link, never an automatic cascade.
 */
export function RemoveDirectGrantDialog({
  member, roleText, onCancel, onConfirm,
}: {
  member: ProjectMember | null
  roleText: string
  onCancel: () => void
  onConfirm: (m: ProjectMember) => void
}) {
  const t = useT()
  // The acknowledgement is per member, so reopening for someone else starts unchecked.
  const [checkedFor, setCheckedFor] = useState<number | null>(null)
  const checked = member != null && checkedFor === member.userId
  const after = member?.afterDirectRemoval
  const from = after?.from?.length ? after.from : null
  const orgId = member?.inheritedFrom?.[0]?.id ?? from?.[0]?.id ?? null
  const href = from ? scopeHref(from[from.length - 1], from[0]?.type === "org" ? from[0].id : orgId) : undefined
  return (
    <Dialog open={member !== null} onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("org.membersPage.removeMemberTitle")}</DialogTitle>
          <DialogDescription>
            {member
              ? t("org.membersPage.removeMemberDescription", { username: member.username, role: roleText })
              : ""}
          </DialogDescription>
        </DialogHeader>
        {after && from && (
          <p className="text-sm" data-testid="remove-surviving-access">
            {t("org.roster.stillHasAccess", {
              role: roleLabel(t, after.roleLevel),
              path: formatScopePath(from),
            })}
            {href && (
              <>
                {" "}
                <a href={href} className="text-primary underline-offset-4 hover:underline">
                  {t("org.roster.removeThere", { path: formatScopePath(from) })}
                </a>
              </>
            )}
          </p>
        )}
        <label className="flex items-start gap-2 py-2 text-sm">
          <Checkbox checked={checked} onCheckedChange={(v) => setCheckedFor(v === true && member ? member.userId : null)} className="mt-0.5" />
          <span>{t("dialog.confirmCheckboxDefault")}</span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button
            variant="destructive"
            disabled={!checked}
            onClick={() => { if (member) onConfirm(member) }}
          >
            {t("org.membersPage.remove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
