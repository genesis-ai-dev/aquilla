import { useEffect, useState } from 'react'
import { SettingsBlock, SettingsGroup, SettingsRow } from '@/components/ui/page'
import { useT } from '@/lib/i18n/I18nProvider'
import type { MessageKey } from '@/lib/i18n/messages/en'
import { getBillingWorkspace, type BillingWorkspace } from '@/lib/sync/billing-workspace'

const explanations: Record<BillingWorkspace['eligibility']['reason'], MessageKey> = {
  ready: 'billing.workspace.eligibility.ready',
  scope_unconfirmed: 'billing.workspace.eligibility.scope_unconfirmed',
  existing_billing: 'billing.review.existing_billing',
  covered_access: 'billing.review.covered_access',
  already_subscribed: 'billing.workspace.eligibility.already_subscribed',
  personal_collaboration_review: 'billing.workspace.eligibility.personal_collaboration_review',
}

export function BillingWorkspaceSummary({ jwt, orgId }: { jwt: string; orgId: number }) {
  const t = useT()
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
    <SettingsGroup label={t('billing.workspace.title')}>
      <SettingsBlock>
        <p className="text-sm text-muted-foreground" role="status">
          {failed ? t('billing.workspace.unavailable') : t('billing.workspace.loading')}
        </p>
      </SettingsBlock>
    </SettingsGroup>
  )
}

/** Shares the page's authoritative response instead of fetching a second snapshot. */
export function BillingWorkspaceDetails({ data }: { data: BillingWorkspace }) {
  const t = useT()
  return (
    <SettingsGroup label={t('billing.workspace.title')}>
      <div data-testid="billing-workspace">
        <SettingsRow
          label={data.name ?? t('billing.review.currentWorkspace')}
          description={data.scope === 'personal' ? t('billing.review.personal') : data.scope === 'team' ? t('billing.review.team') : t('billing.review.unconfirmed')}
        />
        <SettingsBlock className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{data.eligibility.reason === 'already_subscribed' && data.portalEnabled === true
            ? t('billing.workspace.manageInStripe')
            : t(explanations[data.eligibility.reason])}</p>
          {data.entitlement?.access ? (
            <p className="text-sm text-muted-foreground" data-testid="billing-access" role="status">
              {data.entitlement.access.reason === 'payment_failed'
                ? t('billing.workspace.paymentFailed')
                : data.entitlement.access.reason === 'paid_period_ended'
                  ? t('billing.workspace.paidPeriodEnded')
                  : data.entitlement.access.cancelAtPeriodEnd
                    ? t('billing.workspace.canceled', { date: new Date(data.entitlement.access.paidThrough).toLocaleString() })
                    : t('billing.workspace.paidThrough', { date: new Date(data.entitlement.access.paidThrough).toLocaleString() })}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {t('billing.workspace.allowanceScope')}
          </p>
          {typeof data.usagePercent === 'number' && data.usageResetsAt ? (
            <p className="text-sm text-muted-foreground" data-testid="billing-usage-percent" role="status">
              {t('billing.workspace.usagePercent', { percent: data.usagePercent, date: new Date(data.usageResetsAt).toLocaleString() })}
            </p>
          ) : data.entitlement ? <p className="text-sm text-muted-foreground">
            {t('billing.workspace.usagePeriodEnds', { date: new Date(data.entitlement.usagePeriodEnd).toLocaleString() })}
          </p> : null}
        </SettingsBlock>
      </div>
    </SettingsGroup>
  )
}
