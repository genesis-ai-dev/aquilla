import { afterEach, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AccountsProvider, useAccounts } from "./useAccounts"
import { analyticsAccount } from "@/lib/analytics-account"
import { _resetDbForTesting, addSession } from "@/lib/frontier/session-store"
import { clearAllLocalData } from "@/lib/store/project-index"
import { ANALYTICS_DISCLOSURE_VERSION } from "../../shared/analytics-consent"
vi.unmock("@/lib/analytics-account")
afterEach(() => { analyticsAccount.invalidate(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it("invalidates before account switching and enables only for the account React has committed", async () => {
  await _resetDbForTesting(); await clearAllLocalData(); localStorage.clear()
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true)
  vi.spyOn(document, "hidden", "get").mockReturnValue(false)
  vi.stubGlobal("fetch", vi.fn(async (_url, options: RequestInit) => {
    const alice = new Headers(options.headers).get("Authorization") === "Bearer a"
    return new Response(JSON.stringify({ accountId: alice ? "1" : "2", decision: alice ? {
      allowed: true, disclosureVersion: ANALYTICS_DISCLOSURE_VERSION, revision: "1", decidedAt: new Date().toISOString(), source: "settings",
    } : null }))
  }))
  await addSession({ username: "alice", jwt: "a", createdAt: "now" })
  await addSession({ username: "bob", jwt: "b", createdAt: "now" })
  let accounts!: ReturnType<typeof useAccounts>
  function Surface() {
    accounts = useAccounts()
    return <span data-testid="rendered-account">{accounts.active?.username ?? "signed out"}</span>
  }
  const mismatches: string[] = []
  const unsubscribe = analyticsAccount.subscribe(() => {
    if (analyticsAccount.eligible() && screen.queryByTestId("rendered-account")?.textContent !== analyticsAccount.getSnapshot().username) mismatches.push("wrong rendered owner")
  })
  const view = render(<QueryClientProvider client={new QueryClient()}><AccountsProvider><Surface /></AccountsProvider></QueryClientProvider>)
  try {
    await waitFor(() => expect(analyticsAccount.eligible()).toBe(true))
    let switching!: Promise<void>
    act(() => { switching = accounts.activate("bob") })
    expect(analyticsAccount.eligible()).toBe(false)
    await act(async () => { await switching })
    await waitFor(() => expect(analyticsAccount.getSnapshot().accountId).toBe("2"))
    expect(analyticsAccount.eligible()).toBe(false)
    await act(async () => { await accounts.activate("alice") })
    await waitFor(() => expect(analyticsAccount.eligible()).toBe(true))
    expect(mismatches).toEqual([])
    await act(async () => { await accounts.removeAll() })
    expect(analyticsAccount.eligible()).toBe(false)
  } finally { unsubscribe(); view.unmount() }
})
