import { afterEach, describe, expect, it, vi } from "vitest"
import { getOrgBilling, startBillingCheckout, startBillingPortal } from "./billing"

const fetchMock = vi.fn()
vi.stubGlobal("fetch", fetchMock)

afterEach(() => {
  fetchMock.mockReset()
})

describe("billing client", () => {
  it("GETs the org billing snapshot", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ plan: "none", wordsUsed: 0, canSubscribe: true }),
    })
    const data = await getOrgBilling("jwt", 7)
    expect(data?.plan).toBe("none")
    expect(fetchMock.mock.calls[0][0]).toContain("/api/v2/orgs/7/billing")
  })

  it("returns null on 403 so viewers hide the page", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 })
    expect(await getOrgBilling("jwt", 7)).toBeNull()
  })

  it("POSTs Field Plan checkout and returns the Stripe URL", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://checkout.stripe.com/c/session" }),
    })
    await expect(startBillingCheckout("jwt", 7, "field")).resolves.toBe("https://checkout.stripe.com/c/session")
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe("POST")
    expect(init.body).toBe(JSON.stringify({ kind: "field", packs: 1 }))
  })

  it("POSTs the customer portal", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://billing.stripe.com/p/session" }),
    })
    await expect(startBillingPortal("jwt", 7)).resolves.toBe("https://billing.stripe.com/p/session")
  })
})
