import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SettingsGroup } from '@/components/ui/page'
import { getBillingPlanReview, type BillingPlanReview as Review,
  type BillingPlanSelection } from '@/lib/sync/billing-review'

const restrictions: Record<Extract<Review, { ready: false }>['reason'], string> = {
  wrong_scope: 'This plan does not match the workspace type. Choose an Individual plan for a personal workspace or a Team plan for a team workspace.',
  scope_unconfirmed: 'Contact support to confirm this workspace’s type before choosing a paid plan.',
  existing_billing: 'This workspace has existing billing or an agreed allowance. Contact us before changing plans.',
  covered_access: 'This workspace has covered access. Contact us before purchasing a subscription.',
  already_subscribed: 'This workspace already has a paid plan. Plan changes are not available yet.',
  personal_collaboration_review: 'This personal workspace has collaborators. Contact us to confirm the right plan.',
}

/** Parent keys this preview by workspace, session, offer, and interval. */
export function BillingPlanReview({ jwt, orgId, selection, onDismiss }: {
  jwt: string; orgId: number; selection: BillingPlanSelection; onDismiss: () => void
}) {
  const region = useRef<HTMLElement>(null)
  useEffect(() => { region.current?.focus() }, [])
  const [review, setReview] = useState<Review | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let canceled = false
    setReview(null)
    setFailed(false)
    void getBillingPlanReview(jwt, orgId, selection).then(value => {
      if (!canceled) setReview(value)
    }).catch(() => { if (!canceled) setFailed(true) })
    return () => { canceled = true }
  }, [jwt, orgId, selection, attempt])
  const money = (amount: number, currency: string) => new Intl.NumberFormat(undefined, {
    style: 'currency', currency: currency.toUpperCase(),
  }).format(amount / 100)
  return <section ref={region} tabIndex={-1} aria-label="Review selected plan" aria-live="polite" className="p-4">
    <SettingsGroup label="Review selected plan">
      <div className="flex flex-col gap-3 p-4">
      {!review && !failed && <p role="status">Checking workspace and current prices…</p>}
      {failed && <>
        <p role="alert">Plan review is unavailable. Your current access stays unchanged.</p>
        <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Try review again</Button>
      </>}
      {review && <>
        <p>Workspace: <strong>{review.workspace.name ?? 'Current workspace'}</strong></p>
        <p>{review.workspace.scope === 'personal' ? 'Personal workspace'
          : review.workspace.scope === 'team' ? 'Team workspace — shared billing'
          : 'Workspace type needs confirmation'}</p>
        {review.ready ? <>
          <p><strong>{review.offer.label}</strong> · {review.offer.capacityLabel} capacity</p>
          <p>{money(review.offer.totalAmount, review.offer.currency)} billed {review.offer.interval === 'year' ? 'annually' : 'monthly'}.</p>
          {review.offer.interval === 'year' && <p>Equivalent to {money(review.offer.monthlyEquivalent, review.offer.currency)}/month.</p>}
          <p>This plan applies only to this workspace. AI capacity resets every seven days, independently of billing.</p>
          <p>Paid checkout is coming soon. Reviewing a plan does not change your access or create a subscription.</p>
          <Button disabled>Checkout coming soon</Button>
        </> : <p>{restrictions[review.reason]}</p>}
      </>}
      <Button variant="ghost" onClick={onDismiss}>Close plan review</Button>
      </div>
    </SettingsGroup>
  </section>
}
