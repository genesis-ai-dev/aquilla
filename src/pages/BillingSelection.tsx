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
  const [params] = useSearchParams()
  const intent = readBillingIntent(params)
  const { session, loading, sessionLoadError, retrySessionLoad } = useFrontierSession()
  if (intent.kind !== 'paid') return <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
    <h1 className="text-2xl font-semibold">Plan selection unavailable</h1>
    <p>This link does not contain a supported plan and billing interval.</p>
    <a href="/pricing">Compare plans</a>
  </main>
  if (loading) return <p role="status">Loading your account…</p>
  if (sessionLoadError && !session) return <SessionHydrationError retry={retrySessionLoad} />
  const path = billingSelectionPath(intent.selection)
  return <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
    <h1 className="text-2xl font-semibold">Choose a workspace for this plan</h1>
    <p>Review the plan against a workspace before purchasing. Paid checkout is coming soon.</p>
    {!session || isJwtExpired(session.jwt) ? <>
      <p>Sign in or create an account to keep your selected plan and billing interval.</p>
      <Link to={loginPath({ next: path })}>Sign in to review plan</Link>
      <Link to={onboardingForBillingNext(path)}>Create an account</Link>
    </> : <WorkspaceChoice key={`${session.jwt}:${path}`} jwt={session.jwt} selection={intent.selection} />}
    <Link to="/app">Continue to Aquilla</Link>
  </main>
}
function WorkspaceChoice({ jwt, selection }: { jwt: string; selection: BillingPlanSelection }) {
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
    {!orgs && !failed && <p role="status">Loading workspaces…</p>}
    {failed && <>
      <p role="alert">Workspaces are unavailable. Please try again.</p>
      <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Try workspaces again</Button>
    </>}
    {eligible?.length === 0 && <p>No workspace grants you billing authority. Create a workspace in Aquilla or ask its owner for access, then return to this link.</p>}
    {eligible && eligible.length > 0 && <div className="flex flex-col gap-3">
      {eligible.map(org => <Button key={org.id} variant="outline" onClick={() => setSelected(org.id)}>
        Review for {org.name ?? `workspace ${org.id}`}
      </Button>)}
    </div>}
    {selected !== null && <BillingPlanReview key={selected} jwt={jwt} orgId={selected}
      selection={selection} onDismiss={() => setSelected(null)} />}
  </>
}
