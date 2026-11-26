/**
 * AQU-2321: confirm a removal before it is written. Opens with a person and
 * the grants to remove, runs the server's removal dry run, and says what the
 * person loses and what they keep (and through which grant). Any kept grant
 * this viewer may also remove gets its own checkbox; nothing else is touched,
 * so a removal never demotes what another grant still gives.
 *
 * A pending invite uses the same dialog without the keeps section.
 *
 * Reusable on purpose: the person inspector (AQU-2323) opens it with every
 * grant a person holds for "Remove all access", and with one grant per card.
 */
import { useEffect, useState } from "react"
import { UserMinus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { toast } from "@/components/ui/toast"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { grantKey, type GrantRef } from "@/lib/access/edit-access"
import { useT } from "@/lib/i18n/I18nProvider"

import { extraGrants, fetchRemovalPreview, removeGrants, type RemovalPerson, type RemovalState } from "./edit-access-data"
import { RemovalPreviewPanel } from "./RemovalPreviewPanel"

export type RemoveAccessPerson =
  | { userId: string; displayName: string }
  | { inviteId: string; email: string }

export interface RemoveAccessDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: number
  person: RemoveAccessPerson
  /** The grants to remove. Ignored for an invite: cancelling it is the whole removal. */
  grants: GrantRef[]
  /** After anything was written (even a partial removal). The page re-reads the lens here. */
  onRemoved?: () => void
}

export function RemoveAccessDialog({ open, onOpenChange, ...rest }: RemoveAccessDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Closed is unmounted: every open runs a fresh dry run. */}
      {open && (
        <DialogContent data-testid="remove-access-dialog" className="sm:max-w-lg">
          <RemoveAccessBody {...rest} onClose={() => onOpenChange(false)} />
        </DialogContent>
      )}
    </Dialog>
  )
}

function RemoveAccessBody({ orgId, person, grants, onRemoved, onClose }: Omit<RemoveAccessDialogProps, "open" | "onOpenChange"> & { onClose: () => void }) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const invite = "inviteId" in person
  const who: RemovalPerson = invite ? { inviteId: person.inviteId } : { userId: person.userId }
  const request = JSON.stringify({ person: who, grants: invite ? [] : grants })
  const [state, setState] = useState<RemovalState>({ status: "loading" })
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!jwt) return
    let cancelled = false
    fetchRemovalPreview(jwt, orgId, JSON.parse(request) as { person: RemovalPerson; grants: GrantRef[] }).then(
      (result) => {
        if (cancelled) return
        setState(result.ok ? { status: "ready", preview: result.preview } : { status: "refused", message: result.refused.message })
      },
      () => { if (!cancelled) setState({ status: "error" }) },
    )
    return () => { cancelled = true }
  }, [jwt, orgId, request])

  const toggle = (grant: GrantRef, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (on) next.add(grantKey(grant))
      else next.delete(grantKey(grant))
      return next
    })
  }

  const confirm = async () => {
    if (state.status !== "ready" || !jwt || submitting) return
    const also = extraGrants(state.preview, grants).filter((e) => checked.has(grantKey(e.grant))).map((e) => e.grant)
    setSubmitting(true)
    setFailure(null)
    const outcome = await removeGrants(jwt, orgId, who, [...grants, ...also])
    if (outcome.done > 0) onRemoved?.()
    if (outcome.error == null) {
      toast.add({
        type: "success",
        title: invite ? t("org.access.remove.doneInvite", { email: person.email }) : t("org.access.remove.done", { name: person.displayName }),
      })
      onClose()
      return
    }
    setSubmitting(false)
    setFailure(outcome.done === 0 ? t("org.access.remove.failed") : t("org.access.remove.partial", { done: outcome.done, total: outcome.total }))
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {invite ? t("org.access.remove.titleInvite", { email: person.email }) : t("org.access.remove.title", { name: person.displayName })}
        </DialogTitle>
        <DialogDescription>{t("org.access.remove.description")}</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex min-w-0 flex-col gap-3">
        <RemovalPreviewPanel state={state} removing={grants} checked={checked} onToggle={toggle} />
        {failure && <p role="alert" data-testid="removal-failure" className="text-sm text-destructive">{failure}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {invite ? t("org.access.remove.keepInvite") : t("common.cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => void confirm()}
          disabled={state.status !== "ready" || submitting}
          data-testid="remove-access-confirm"
        >
          <UserMinus aria-hidden />
          {invite ? t("org.access.remove.confirmInvite") : t("org.access.remove.confirm")}
        </Button>
      </DialogFooter>
    </>
  )
}
