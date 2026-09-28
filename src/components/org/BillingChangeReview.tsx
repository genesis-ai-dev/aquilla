import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SettingsGroup } from '@/components/ui/page'
import { billingOfferLabels } from '../../../db/shared/billing-offers'
import type { BillingPlanSelection } from '@/lib/sync/billing-review'
import { getBillingChangeReview, type BillingChangeReview as Review } from '@/lib/sync/billing-change-review'

/** Keyed by the parent to keep workspace, session and selection responses isolated. */
export function BillingChangeReview({ jwt, orgId, selection, onDismiss }: {
  jwt: string; orgId: number; selection: BillingPlanSelection; onDismiss: () => void
}) {
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
  return <section ref={region} tabIndex={-1} aria-label="Review plan change" aria-live="polite" className="p-4">
    <SettingsGroup label="Review plan change">
      <div className="flex flex-col gap-3 p-4">
        {!review && !failed && <p role="status">Checking the subscription and change amount…</p>}
        {failed && <>
          <p role="alert">Plan change review is unavailable. Your current plan stays unchanged.</p>
          <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Try change review again</Button>
        </>}
        {review && <>
          <p>Workspace: <strong>{review.workspace.name ?? 'Current workspace'}</strong></p>
          <p>{billingOfferLabels[review.currentOffer]} → <strong>{review.target.label}</strong></p>
          <p>{money(review.target.totalAmount)} billed {review.target.interval === 'year' ? 'annually' : 'monthly'}.</p>
          {review.direction === 'upgrade' ? <>
            <p>Prorated charge due now: <strong>{money(review.amountDueNow)}</strong>.</p>
            <p>The higher cap starts after successful payment. Your usage this week stays counted.</p>
          </> : <>
            <p>No charge now. The lower plan starts at the next billing cycle, {new Date(review.effectiveAt).toLocaleString()}.</p>
            <p>Your current plan and cap continue until then. Your usage week does not restart when the lower cap takes effect.</p>
          </>}
          <p>Weekly usage resets {new Date(review.usagePeriodEnd).toLocaleString()}.</p>
          <p>This review expires {new Date(review.expiresAt).toLocaleString()}. Reviewing does not change your plan.</p>
          <Button disabled>Plan changes coming soon</Button>
        </>}
        <Button variant="ghost" onClick={onDismiss}>Close change review</Button>
      </div>
    </SettingsGroup>
  </section>
}
