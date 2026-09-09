import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SettingsGroup, SettingsRow } from '@/components/ui/page'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getBillingOffers, type BillingOffers as Offers } from '@/lib/sync/billing'

export function BillingOffers({ jwt, orgId }: { jwt: string; orgId: number }) {
  const [result, setResult] = useState<{ orgId: number; jwt: string; data: Offers } | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [interval, setInterval] = useState<'month' | 'year'>('year')
  useEffect(() => {
    let canceled = false
    setResult(null)
    setUnavailable(false)
    void getBillingOffers(jwt, orgId).then(data => {
      if (!canceled) setResult({ orgId, jwt, data })
    }).catch(() => {
      if (!canceled) setUnavailable(true)
    })
    return () => { canceled = true }
  }, [jwt, orgId])
  const data = result?.orgId === orgId && result.jwt === jwt ? result.data : null
  const money = (amount: number, currency: string) => new Intl.NumberFormat(undefined, {
    style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 2,
  }).format(amount / 100)

  return (
    <SettingsGroup label="Compare new plans">
      <p className="text-sm text-muted-foreground">
        Compare personal and shared team capacity. Paid checkout is coming soon.
        Your current workspace plan stays unchanged.
      </p>
      <Tabs defaultValue="team">
        <TabsList aria-label="Plan audience">
          <TabsTrigger value="personal">Individual</TabsTrigger>
          <TabsTrigger value="team">Team &amp; Enterprise</TabsTrigger>
        </TabsList>
        <Select value={interval} onValueChange={value => {
          if (value === 'month' || value === 'year') setInterval(value)
        }}>
          <SelectTrigger aria-label="Plan billing period">
            <SelectValue>{interval === 'year' ? 'Annual' : 'Monthly'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="year">Annual</SelectItem>
              <SelectItem value="month">Monthly</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {(['personal', 'team'] as const).map(scope => (
          <TabsContent key={scope} value={scope}>
            <div className="flex flex-col gap-4">
              {scope === 'personal' && <SettingsRow label="Free" description="Explore Aquilla with basic AI assistance. No card required." />}
              {!data && !unavailable ? <p role="status">Loading plan prices…</p> : null}
              {unavailable || data?.available === false ? (
                <p role="status">Plan prices are temporarily unavailable. Your current plan and access are unchanged.</p>
              ) : null}
              {data?.available && data.offers.filter(offer => offer.scope === scope && offer.interval === interval).map(offer => (
                <SettingsRow
                  key={offer.offer}
                  label={offer.label}
                  description={`${offer.capacityLabel} capacity${scope === 'team' ? ', shared across your team' : ' for your personal workspace'}.`}
                  control={
                    <div className="flex flex-col items-end gap-2">
                      <span>{money(offer.monthlyEquivalent, offer.currency)}/month</span>
                      <span className="text-sm text-muted-foreground">
                        {interval === 'year' ? `${money(offer.totalAmount, offer.currency)} billed annually` : 'Billed monthly'}
                      </span>
                      <Button disabled aria-label={`${offer.label} coming soon`}>Coming soon</Button>
                    </div>
                  }
                />
              ))}
              {scope === 'team' && <SettingsRow label="Enterprise" description="An agreed plan for organization-wide rollout and support." control={
                <a className="text-sm underline" href="https://aquilla.app/90-day-rollout">Discuss your rollout</a>
              } />}
            </div>
          </TabsContent>
        ))}
      </Tabs>
      <p className="text-sm text-muted-foreground">
        New plans reset AI capacity every seven days, with no rollover.
        Monthly or annual billing does not change usage resets.
        Usage varies with the work performed.
      </p>
    </SettingsGroup>
  )
}
