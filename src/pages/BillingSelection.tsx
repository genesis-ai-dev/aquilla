import { useT } from '@/lib/i18n/I18nProvider'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useFrontierSession } from '@/hooks/useFrontierSession'
import { isJwtExpired } from '@/lib/frontier/auth'
import { listMyOrgs, type MyOrg } from '@/lib/frontier/orgs'
import { billingSelectionPath, onboardingForBillingNext, readBillingIntent } from '@/lib/billing/intent'
import { loginPath } from '@/lib/navigation/login-path'
import { Button } from '@/components/ui/button'
import { BillingPlanReview } from '@/components/org/BillingPlanReview'
import type { BillingPlanSelection } from '@/lib/sync/billing-review'
import { SessionHydrationError } from '@/components/SessionHydrationError'

export function BillingSelection() {
  const t = useT()
  const [params] = useSearchParams()
  const intent = readBillingIntent(params)
  const { session, loading, sessionLoadError, retrySessionLoad } = useFrontierSession()
  if (intent.kind !== 'paid') return <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
    <h1 className="text-2xl font-semibold">{t("billing.selection.unavailable")}</h1>
    <p>{t("billing.selection.invalid")}</p>
    <a href="/pricing">{t("billing.selection.compare")}</a>
  </main>
  if (loading) return <p role="status">{t("billing.selection.loading")}</p>
  if (sessionLoadError && !session) return <SessionHydrationError retry={retrySessionLoad} />
  const path = billingSelectionPath(intent.selection)
  return <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
    <h1 className="text-2xl font-semibold">{t("billing.selection.title")}</h1>
    <p>{t("billing.selection.description")}</p>
    {!session || isJwtExpired(session.jwt) ? <>
      <p>{t("billing.selection.signInHelp")}</p>
      <Link to={loginPath({ next: path })}>{t("billing.selection.signIn")}</Link>
      <Link to={onboardingForBillingNext(path)}>{t("billing.selection.create")}</Link>
    </> : <WorkspaceChoice key={`${session.jwt}:${path}`} jwt={session.jwt} selection={intent.selection} />}
    <Link to="/app">{t("billing.selection.continue")}</Link>
  </main>
}
function WorkspaceChoice({ jwt, selection }: { jwt: string; selection: BillingPlanSelection }) {
  const t = useT()
  const [orgs, setOrgs] = useState<MyOrg[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  useEffect(() => {
    let canceled = false
    setOrgs(null)
    setFailed(false)
    void listMyOrgs(jwt).then(value => { if (!canceled) setOrgs(value) })
      .catch(() => { if (!canceled) setFailed(true) })
    return () => { canceled = true }
  }, [jwt, attempt])
  const eligible = orgs?.filter(org => org.role.level >= 600)
  return <>
    {!orgs && !failed && <p role="status">{t("billing.selection.workspacesLoading")}</p>}
    {failed && <>
      <p role="alert">{t("billing.selection.workspacesUnavailable")}</p>
      <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>{t("billing.selection.retry")}</Button>
    </>}
    {eligible?.length === 0 && <p>{t("billing.selection.noWorkspace")}</p>}
    {eligible && eligible.length > 0 && <div className="flex flex-col gap-3">
      {eligible.map(org => <Button key={org.id} variant="outline" onClick={() => setSelected(org.id)}>
        {t("billing.selection.reviewFor", { workspace: org.name ?? t("billing.selection.workspaceFallback", { id: String(org.id) }) })}
      </Button>)}
    </div>}
    {selected !== null && <BillingPlanReview key={selected} jwt={jwt} orgId={selected}
      selection={selection} onDismiss={() => setSelected(null)} />}
  </>
}
