import { useSyncExternalStore } from "react"
import { analyticsAccount } from "@/lib/analytics-account"
import posthog from "@/lib/posthog"

type AnalyticsScope = ReturnType<typeof posthog.scope>

// AQU-2654. A scope is bound to the account's analytics generation, and a
// scope made while collection is not approved can never send anything: its
// approval is decided when it is made. The account's state is republished
// about a dozen times when the tab is hidden and shown again (suspended,
// invalidated, re-verified), and all but the last of those leave collection
// unapproved. Handing every consumer a new scope object for each of them
// re-rendered the workspace once per publish for scopes that all do the same
// thing: nothing.
//
// So the scopes that cannot send are one object per owner, and a sending scope
// is one object per generation. Consumers re-render when what their scope can
// do changes, not when the state object behind it was replaced.
const unapproved = new Map<string | null, AnalyticsScope>()
let approved: { generation: number; owner: string | null; scope: AnalyticsScope } | null = null

function currentScope(): AnalyticsScope {
  const { generation, username } = analyticsAccount.getSnapshot()
  if (!analyticsAccount.eligible()) {
    let scope = unapproved.get(username)
    if (!scope) {
      // Made while not eligible, so it stays unable to send.
      scope = posthog.scope(generation)
      unapproved.set(username, scope)
    }
    return scope
  }
  if (!approved || approved.generation !== generation || approved.owner !== username) {
    approved = { generation, owner: username, scope: posthog.scope(generation) }
  }
  return approved.scope
}

/** Old render callbacks retain their original account/approval generation. */
export function useAccountAnalytics() {
  return useSyncExternalStore(analyticsAccount.subscribe, currentScope, currentScope)
}
