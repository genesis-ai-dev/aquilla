import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n/I18nProvider'
import { RichMessage } from '@/lib/i18n/RichMessage'
import { billingOfferLabels } from '../../../db/shared/billing-offers'
import type { BillingPlanSelection } from '@/lib/sync/billing-review'
import { getBillingChangeReview, type BillingChangeReview as Review } from '@/lib/sync/billing-change-review'

/** Keyed by the parent to keep workspace, session and selection responses isolated. */
export function BillingChangeReview({ jwt, orgId, selection, onDismiss }: {
  jwt: string; orgId: number; selection: BillingPlanSelection; onDismiss: () => void
}) {
  const t = useT()
  const region = useRef<HTMLElement>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => { region.current?.focus() }, [])
  useEffect(() => {
    let canceled = false
    setReview(null)
    setFailed(false)
    void getBillingChangeReview(jwt, orgId, selection).then(value => {
      if (!canceled) setReview(value)
    }).catch(() => { if (!canceled) setFailed(true) })
    return () => { canceled = true }
  }, [jwt, orgId, selection, attempt])
  const money = (amount: number) => new Intl.NumberFormat(undefined, {
    style: 'currency', currency: 'USD',
  }).format(amount / 100)
  return <section ref={region} tabIndex={-1} aria-label={t('billing.change.title')} aria-live="polite" className="px-4 py-3">
    <p className="text-sm font-medium text-foreground">{t('billing.change.title')}</p>
    <div className="mt-2 flex flex-col gap-3">
        {!review && !failed && <p role="status">{t('billing.change.loading')}</p>}
      {failed && <>
        <p role="alert">{t('billing.change.unavailable')}</p>
        <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>{t('billing.change.retry')}</Button>
      </>}
      {review && <>
        <p>{t('billing.review.workspaceLabel')} <strong>{review.workspace.name ?? t('billing.review.currentWorkspace')}</strong></p>
        <p>{billingOfferLabels[review.currentOffer]} → <strong>{review.target.label}</strong></p>
        <p>{t(review.target.interval === 'year' ? 'billing.review.annual' : 'billing.review.monthly', { amount: money(review.target.totalAmount) })}</p>
        {review.direction === 'upgrade' ? <>
          <p><RichMessage k="billing.change.dueNow" values={{ amount: <strong>{money(review.amountDueNow)}</strong> }} /></p>
          <p>{t('billing.change.upgradeHelp')}</p>
        </> : <>
          <p>{t('billing.change.downgradeStarts', { date: new Date(review.effectiveAt).toLocaleString() })}</p>
          <p>{t('billing.change.downgradeHelp')}</p>
        </>}
        <p>{t('billing.change.usageResets', { date: new Date(review.usagePeriodEnd).toLocaleString() })}</p>
        <p>{t('billing.change.expires', { date: new Date(review.expiresAt).toLocaleString() })}</p>
        <Button disabled>{t('billing.change.comingSoon')}</Button>
      </>}
      <Button variant="ghost" onClick={onDismiss}>{t('billing.change.close')}</Button>
    </div>
  </section>
}
