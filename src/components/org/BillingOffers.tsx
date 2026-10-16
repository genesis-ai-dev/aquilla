import { useEffect, useState } from 'react'
import { BillingChangeReview } from './BillingChangeReview'
import { BillingPlanReview } from './BillingPlanReview'
import type { BillingPlanSelection } from '@/lib/sync/billing-review'
import { Button } from '@/components/ui/button'
import { SettingsBlock, SettingsGroup, SettingsRow } from '@/components/ui/page'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getBillingOffers, type BillingOffers as Offers } from '@/lib/sync/billing'
import { useT } from '@/lib/i18n/I18nProvider'

export function BillingOffers({ jwt, orgId, changingPlan = false, currentInterval }: {
  jwt: string; orgId: number; changingPlan?: boolean; currentInterval?: 'month' | 'year'
}) {
  const t = useT()
  const [result, setResult] = useState<{ orgId: number; jwt: string; data: Offers } | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [selected, setSelected] = useState<{ orgId: number; jwt: string; selection: BillingPlanSelection } | null>(null)
  const [interval, setInterval] = useState<'month' | 'year'>(currentInterval ?? 'year')
  useEffect(() => {
    let canceled = false
    setResult(null)
    setUnavailable(false)
    setSelected(null)
    setInterval(currentInterval ?? 'year')
    void getBillingOffers(jwt, orgId).then(data => {
      if (!canceled) setResult({ orgId, jwt, data })
    }).catch(() => {
      if (!canceled) setUnavailable(true)
    })
    return () => { canceled = true }
  }, [jwt, orgId, changingPlan, currentInterval])
  const data = result?.orgId === orgId && result.jwt === jwt ? result.data : null
  const money = (amount: number, currency: string) => new Intl.NumberFormat(undefined, {
    style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 2,
  }).format(amount / 100)

  const Review = changingPlan ? BillingChangeReview : BillingPlanReview
  return (
    <SettingsGroup label={t('billing.offers.title')}>
      <SettingsBlock>
        <p className="text-sm text-muted-foreground">
          {t('billing.offers.intro')}
        </p>
      </SettingsBlock>
      <Tabs defaultValue="team" onValueChange={() => setSelected(null)}>
        <SettingsBlock className="flex flex-wrap items-center gap-3">
          <TabsList aria-label={t('billing.offers.audienceAria')}>
            <TabsTrigger value="personal">{t('billing.offers.individual')}</TabsTrigger>
            <TabsTrigger value="team">{t('billing.offers.team')}</TabsTrigger>
          </TabsList>
          <Select value={interval} onValueChange={value => {
            if (value === 'month' || value === 'year') {
              setInterval(value)
              setSelected(null)
            }
          }}>
            <SelectTrigger aria-label={t('billing.offers.intervalAria')}>
              <SelectValue>{interval === 'year' ? t('billing.offers.annual') : t('billing.offers.monthly')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="year">{t('billing.offers.annual')}</SelectItem>
                <SelectItem value="month">{t('billing.offers.monthly')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsBlock>
        {(['personal', 'team'] as const).map(scope => (
          <TabsContent key={scope} value={scope}>
            <div className="flex flex-col">
              {scope === 'personal' && <SettingsRow label={t('billing.plan.free')} description={t('billing.offers.freeDescription')} />}
              {!data && !unavailable ? <SettingsBlock><p role="status">{t('billing.offers.loading')}</p></SettingsBlock> : null}
              {unavailable || data?.available === false ? (
                <SettingsBlock><p role="status">{t('billing.offers.unavailable')}</p></SettingsBlock>
              ) : null}
              {data?.available && data.offers.filter(offer => offer.scope === scope && offer.interval === interval).map(offer => (
                <SettingsRow
                  key={offer.offer}
                  label={offer.label}
                  description={t(scope === 'team' ? 'billing.offers.teamCapacity' : 'billing.offers.personalCapacity', { capacity: offer.capacityLabel })}
                  control={
                    <div className="flex flex-col items-end gap-2">
                      <span>{t('billing.offers.perMonth', { amount: money(offer.monthlyEquivalent, offer.currency) })}</span>
                      <span className="text-sm text-muted-foreground">
                        {interval === 'year' ? t('billing.offers.billedAnnually', { amount: money(offer.totalAmount, offer.currency) }) : t('billing.offers.billedMonthly')}
                      </span>
                      <Button variant="outline" onClick={() => setSelected({ orgId, jwt,
                        selection: { offer: offer.offer, interval, quantity: 1 },
                      })}>{t('billing.offers.review', { plan: offer.label })}</Button>
                    </div>
                  }
                />
              ))}
              {scope === 'team' && <SettingsRow label={t('billing.plan.enterprise')} description={t('billing.offers.enterpriseDescription')} control={
                <a className="text-sm underline" href="https://aquilla.app/90-day-rollout">{t('billing.offers.discussRollout')}</a>
              } />}
            </div>
          </TabsContent>
        ))}
      </Tabs>
      {selected?.orgId === orgId && selected.jwt === jwt && <Review
        key={`${orgId}:${jwt}:${selected.selection.offer}:${selected.selection.interval}`}
        jwt={jwt} orgId={orgId} selection={selected.selection}
        onDismiss={() => setSelected(null)}
      />}
      <SettingsBlock>
        <p className="text-sm text-muted-foreground">
          {t('billing.offers.resetNote')}
        </p>
      </SettingsBlock>
    </SettingsGroup>
  )
}
