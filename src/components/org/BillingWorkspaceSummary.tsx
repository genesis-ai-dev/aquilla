import { useEffect, useState } from 'react'
import { SettingsGroup, SettingsRow } from '@/components/ui/page'
import { getBillingWorkspace, type BillingWorkspace } from '@/lib/sync/billing-workspace'

const explanations: Record<BillingWorkspace['eligibility']['reason'], string> = {
  ready: 'Plan options match this workspace. Paid checkout is not open yet.',
  scope_unconfirmed: 'Confirm this workspace’s type with support before choosing a paid plan. Your existing access stays unchanged.',
  existing_billing: 'This workspace has existing billing or an agreed allowance. Contact us before changing plans.',
  covered_access: 'This workspace has covered access. Contact us before purchasing a subscription.',
  already_subscribed: 'This workspace already has a paid plan. Changes will be available when billing management is ready.',
  personal_collaboration_review: 'This personal workspace has collaborators. Contact us to confirm the right plan before purchasing.',
}

export function BillingWorkspaceSummary({ jwt, orgId }: { jwt: string; orgId: number }) {
  const [result, setResult] = useState<{ jwt: string; data: BillingWorkspace } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let canceled = false
    setResult(null)
    setFailed(false)
    void getBillingWorkspace(jwt, orgId).then(data => {
      if (!canceled) setResult({ jwt, data })
    }).catch(() => { if (!canceled) setFailed(true) })
    return () => { canceled = true }
  }, [jwt, orgId])
  const data = result?.jwt === jwt && result.data.orgId === orgId ? result.data : null
  return data ? <BillingWorkspaceDetails data={data} /> : (
    <SettingsGroup label="Workspace billing">
      <p className="text-sm text-muted-foreground" role="status">
        {failed ? 'Workspace billing details are unavailable. Your current access stays unchanged.' : 'Loading workspace billing…'}
      </p>
    </SettingsGroup>
  )
}

/** Shares the page's authoritative response instead of fetching a second snapshot. */
export function BillingWorkspaceDetails({ data }: { data: BillingWorkspace }) {
  return (
    <SettingsGroup label="Workspace billing">
      <div className="flex flex-col gap-4" data-testid="billing-workspace">
        <SettingsRow
          label={data.name ?? 'Current workspace'}
          description={data.scope === 'personal' ? 'Personal workspace' : data.scope === 'team' ? 'Team workspace — shared billing' : 'Workspace type needs confirmation'}
        />
        <p className="text-sm text-muted-foreground">{explanations[data.eligibility.reason]}</p>
        {data.entitlement?.access ? (
          <p className="text-sm text-muted-foreground" data-testid="billing-access" role="status">
            {data.entitlement.access.reason === 'payment_failed'
              ? 'Payment failed. Your AI allowance falls back to Free. This week’s usage still counts; if it exceeds Free’s allowance, AI pauses until the weekly reset or payment recovery.'
              : data.entitlement.access.reason === 'paid_period_ended'
                ? 'Your paid period has ended. Your AI allowance follows Free, with this week’s usage still counted.'
                : data.entitlement.access.cancelAtPeriodEnd
                  ? `Your subscription is canceled. Paid access continues through ${new Date(data.entitlement.access.paidThrough).toLocaleString()}.`
                  : `Paid access is confirmed through ${new Date(data.entitlement.access.paidThrough).toLocaleString()}.`}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Work on this workspace’s projects uses this workspace’s allowance.
          A collaborator’s personal subscription does not add capacity here.
        </p>
        {data.entitlement ? <p className="text-sm text-muted-foreground">
          Usage period ends {new Date(data.entitlement.usagePeriodEnd).toLocaleString()}.
          Usage measurement is not available yet.
        </p> : null}
      </div>
    </SettingsGroup>
  )
}
