/**
 * AQU-2322: opens Give access from outside the access page (StaffLanePopover
 * today), pre-filled. Give access needs the viewer's Places/People payload —
 * its places, people and `grantable` map are what the dry run gates on — so
 * this reads it first and opens the dialog once it is here. A read that fails
 * (no access to this org's roster) says so and opens nothing.
 */
import { useEffect, useState } from "react"

import { toast } from "@/components/ui/toast"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { ScopeType } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"

import { GiveAccessDialog } from "./GiveAccessDialog"
import { fetchOrgAccess, type OrgAccessPayload } from "./org-access-data"

export interface GiveAccessRequest {
  userId?: string
  roleLevel?: number
  place?: { type: ScopeType; id: string }
  /** A new request each time the opener asks, so asking twice opens twice. */
  nonce: number
}

export function GiveAccessLauncher({
  orgId,
  request,
  onClose,
  onGranted,
}: {
  orgId: number
  request: GiveAccessRequest | null
  onClose: () => void
  onGranted?: () => void
}) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const nonce = request?.nonce ?? null
  const [loaded, setLoaded] = useState<{ nonce: number; payload: OrgAccessPayload } | null>(null)

  useEffect(() => {
    if (nonce == null || !jwt) return
    let cancelled = false
    fetchOrgAccess(jwt, orgId).then(
      (payload) => { if (!cancelled) setLoaded({ nonce, payload }) },
      () => { if (!cancelled) toast.add({ type: "error", title: t("org.access.give.loadError") }) },
    )
    return () => { cancelled = true }
  }, [nonce, jwt, orgId, t])

  if (!request || loaded?.nonce !== request.nonce) return null
  return (
    <GiveAccessDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      orgId={orgId}
      payload={loaded.payload}
      initialPerson={request.userId ? { userId: request.userId } : undefined}
      initialRoleLevel={request.roleLevel}
      initialPlace={request.place}
      onGranted={() => onGranted?.()}
    />
  )
}
