// Project settings → Members → a member's "Revoke all access" confirmation.
//
// AQU-2259: moved out of the unrouted ProjectMembersPage, whose member list
// only the (unreachable) Share dialog used. This and InviteLinkTab are the two
// pieces Project settings → Members still renders.

import { useState } from "react"
import { ShieldOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FieldLabel } from "@/components/ui/field"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { revokeAllProjectAccess, type RevokeAllResult } from "@/lib/frontier/members"
import { RoleLevelLabel } from "@/components/RoleLabel"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import type { ProjectMember } from "@/lib/frontier/members"
import { toUserFacingError } from "@/lib/errors/user-error"
// ──────────────────────────────────────────────────────────────────────────
// Revoke-all confirmation dialog
// ──────────────────────────────────────────────────────────────────────────

interface RevokeAllDialogProps {
  member: ProjectMember
  projectId: string
  onClose: () => void
  onRevoked: () => void
}

export function RevokeAllDialog({
  member, projectId, onClose, onRevoked,
}: RevokeAllDialogProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const [confirmation, setConfirmation] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RevokeAllResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The user must type the member's username to confirm.
  const confirmationRequired = member.username
  const confirmed = confirmation.trim() === confirmationRequired

  async function handleRevoke() {
    if (!session?.jwt || !confirmed) return
    setBusy(true)
    setError(null)
    try {
      const r = await revokeAllProjectAccess(session.jwt, projectId, member.userId)
      setResult(r)
    } catch (e) {
      setError(toUserFacingError(e, "project").message)
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    // Show summary of what happened
    const remainingNonRemovable = result.grantPaths.filter((p) => !p.removable)
    return (
      <Dialog open onOpenChange={(v) => { if (!v) onRevoked() }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("org.membersPage.accessRevokedTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {result.removed ? (
              <p>
                <RichMessage
                  k="org.membersPage.directGrantRemoved"
                  values={{ username: <strong>{member.username}</strong> }}
                />
              </p>
            ) : (
              <p>
                <RichMessage
                  k="org.membersPage.noDirectGrantToRemove"
                  values={{ username: <strong>{member.username}</strong> }}
                />
              </p>
            )}
            {remainingNonRemovable.length > 0 && (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                <p className="mb-2 font-medium text-amber-800 dark:text-amber-300">
                  {t("org.membersPage.accessStillGrantedVia")}
                </p>
                <ul className="space-y-1">
                  {remainingNonRemovable.map((p, i) => (
                    <li key={i} className="text-xs text-amber-700 dark:text-amber-400">
                      <span className="font-medium capitalize">{p.source}</span>
                      {" "}({p.name})
                      {p.hint ? ` — ${p.hint}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={onRevoked}>{t("common.done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <ShieldOff className="h-5 w-5" />
            {t("org.membersPage.revokeAllAccessTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <p>
            <RichMessage
              k="org.membersPage.revokeAllExplanation"
              values={{ username: <strong>{member.username}</strong> }}
            />
          </p>

          {/* Show known grant paths */}
          <div className="rounded border p-3 space-y-1">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              {t("org.membersPage.currentGrantPathsFor", { username: member.username })}
            </p>
            <GrantPathRow
              source={member.role.source}
              level={member.role.level}
              removable={member.role.source === "override"}
            />
            {member.secondarySources?.map((s, i) => (
              <GrantPathRow
                key={i}
                source={s.source}
                level={s.level}
                removable={false}
              />
            ))}
          </div>

          <div className="space-y-1">
            <FieldLabel htmlFor="revoke-confirm" className="text-xs">
              <RichMessage
                k="org.membersPage.typeToConfirm"
                values={{ username: <strong>{confirmationRequired}</strong> }}
              />
            </FieldLabel>
            <Input
              id="revoke-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={confirmationRequired}
              autoComplete="off"
            />
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={!confirmed || busy}
            onClick={() => void handleRevoke()}
          >
            {busy ? t("common.revoking") : t("org.membersPage.revokeAccess")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function GrantPathRow({
  source, level, removable,
}: {
  source: string
  level: number
  removable: boolean
}) {
  const t = useT()
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={cn("font-medium capitalize", removable ? "text-foreground" : "text-muted-foreground")}>
        {source}
      </span>
      {/* Role LABEL only — numeric levels are internal (FRO-368). */}
      <RoleLevelLabel level={level} />
      {removable ? (
        <span className="text-xs text-destructive/70">{t("org.membersPage.willBeRemoved")}</span>
      ) : (
        <span className="text-xs text-amber-600 dark:text-amber-400">{t("org.membersPage.staysGranted")}</span>
      )}
    </div>
  )
}
