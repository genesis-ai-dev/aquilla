import { useT } from '@/lib/i18n/I18nProvider'
import { openExternal } from '@/lib/open-external'
import { startWorkspaceBillingCheckout, expireWorkspaceBillingCheckout, WorkspaceCheckoutConflict } from '@/lib/sync/billing-checkout'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getBillingPlanReview, type BillingPlanReview as Review,
  type BillingPlanSelection } from '@/lib/sync/billing-review'

const restrictions = {
  wrong_scope: 'billing.review.wrong_scope',
  scope_unconfirmed: 'billing.review.scope_unconfirmed',
  existing_billing: 'billing.review.existing_billing',
  covered_access: 'billing.review.covered_access',
  already_subscribed: 'billing.review.already_subscribed',
  personal_collaboration_review: 'billing.review.personal_collaboration_review',
} as const

/** Parent keys this preview by workspace, session, offer, and interval. */
export function BillingPlanReview({ jwt, orgId, selection, onDismiss }: {
  jwt: string; orgId: number; selection: BillingPlanSelection; onDismiss: () => void
}) {
  const t = useT()
  const region = useRef<HTMLElement>(null)
  useEffect(() => { region.current?.focus() }, [])
  const [review, setReview] = useState<Review | null>(null)
  const [checkingOut, setCheckingOut] = useState(false)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [checkoutConflict, setCheckoutConflict] = useState(false)
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function checkout() {
    if (!review?.ready || inFlight.current) return
    inFlight.current = true
    setCheckingOut(true)
    setCheckoutError(null)
    setCheckoutConflict(false)
    try {
      const url = await startWorkspaceBillingCheckout(jwt, review)
      if (alive.current) await openExternal(url)
    } catch (error) {
      if (alive.current) {
        setCheckoutConflict(error instanceof WorkspaceCheckoutConflict)
        setCheckoutError(error instanceof Error ? error.message : t('billing.review.checkoutUnavailable'))
      }
    } finally { inFlight.current = false; if (alive.current) setCheckingOut(false) }
  }
  async function replaceCheckout() {
    if (inFlight.current) return
    inFlight.current = true
    setCheckingOut(true)
    try {
      await expireWorkspaceBillingCheckout(jwt, orgId)
      if (alive.current) {
        setCheckoutConflict(false)
        setCheckoutError(null)
        setAttempt(value => value + 1)
      }
    } catch (error) {
      if (alive.current) setCheckoutError(error instanceof Error ? error.message : t('billing.review.checkoutUnavailable'))
    } finally { inFlight.current = false; if (alive.current) setCheckingOut(false) }
  }
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
  return <section ref={region} tabIndex={-1} aria-label={t("billing.review.title")} aria-live="polite" className="px-4 py-3">
    <p className="text-sm font-medium text-foreground">{t("billing.review.title")}</p>
    <div className="mt-2 flex flex-col gap-3">
      {!review && !failed && <p role="status">{t("billing.review.loading")}</p>}
      {failed && <>
        <p role="alert">{t("billing.review.unavailable")}</p>
        <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>{t("billing.review.retry")}</Button>
      </>}
      {review && <>
        <p>{t("billing.review.workspaceLabel")} <strong>{review.workspace.name ?? t('billing.review.currentWorkspace')}</strong></p>
        <p>{review.workspace.scope === 'personal' ? t('billing.review.personal')
          : review.workspace.scope === 'team' ? t('billing.review.team')
          : t('billing.review.unconfirmed')}</p>
        {review.ready ? <>
          <p><strong>{review.offer.label}</strong> · {t("billing.review.capacity", { capacity: review.offer.capacityLabel })}</p>
          <p>{t(review.offer.interval === 'year' ? 'billing.review.annual' : 'billing.review.monthly', { amount: money(review.offer.totalAmount, review.offer.currency) })}</p>
          {review.offer.interval === 'year' && <p>{t("billing.review.equivalent", { amount: money(review.offer.monthlyEquivalent, review.offer.currency) })}</p>}
          <p>{t("billing.review.period")}</p>
          <p>{review.checkoutEnabled
            ? t('billing.review.payHelp')
            : t('billing.review.comingSoonHelp')}</p>
          <Button disabled={!review.checkoutEnabled || checkingOut} onClick={() => void checkout()}>
            {checkingOut ? t('billing.review.opening') : review.checkoutEnabled ? t('billing.review.continue') : t('billing.review.comingSoon')}
          </Button>
          {checkoutError && <p role="alert">{checkoutError}</p>}
          {checkoutConflict && <Button variant="outline" disabled={checkingOut}
            onClick={() => void replaceCheckout()}>{t('billing.review.cancelPrevious')}</Button>}
        </> : <p>{t(restrictions[review.reason])}</p>}
      </>}
      <Button variant="ghost" onClick={onDismiss}>{t("billing.review.close")}</Button>
    </div>
  </section>
}
