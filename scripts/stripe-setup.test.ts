// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { provisionFieldCatalog } from "./stripe-setup"

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules() })

describe("Stripe sandbox catalog preparation", () => {
  it("rejects a supplied product from another account without creating it", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 404 }))
    vi.stubGlobal("fetch", fetch)
    await expect(provisionFieldCatalog("sk_test_not_real", "prod_other_account"))
      .rejects.toThrow("does not exist in this Stripe account")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("reuses a dashboard-created product and its matching prices without writes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const product = "prod_dashboard_field"
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).not.toBe("POST")
      const parsed = new URL(url)
      if (parsed.pathname.includes("/products/")) return Response.json({ id: product })
      const annual = parsed.searchParams.get("lookup_keys[]")?.includes("_year_")
      return Response.json({ data: [{
        id: annual ? "price_annual" : "price_monthly", product,
        currency: "usd", unit_amount: annual ? 600000 : 60000, active: true,
        recurring: { interval: annual ? "year" : "month", interval_count: 1 },
      }] })
    })
    vi.stubGlobal("fetch", fetch)
    await provisionFieldCatalog("sk_test_not_real", product)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls[0][0]).toContain(`/products/${product}`)
  })

  it("rejects live keys before any Stripe request", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_not_real")
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    await expect(provisionFieldCatalog("sk_live_not_real")).rejects.toThrow("test secret")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("creates only monthly and annual prices and reuses them on a second run", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_not_real")
    vi.spyOn(console, "log").mockImplementation(() => {})
    let productExists = false
    const prices: Record<string, unknown>[] = []
    const writes: string[] = []
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const parsed = new URL(url)
      const path = parsed.pathname
      if (init?.method !== "POST") {
        if (path.includes("/products/")) return new Response("{}", { status: productExists ? 200 : 404 })
        return Response.json({ data: prices.filter(p => p.lookup_key === parsed.searchParams.get("lookup_keys[]")) })
      }
      writes.push(path)
      const body = new URLSearchParams(String(init.body))
      if (path === "/v1/products") { productExists = true; return Response.json({ id: body.get("id") }) }
      const price = {
        id: `price_${prices.length}`, product: body.get("product"), currency: body.get("currency"),
        unit_amount: Number(body.get("unit_amount")), lookup_key: body.get("lookup_key"), active: true,
        recurring: { interval: body.get("recurring[interval]"), interval_count: 1 },
      }
      prices.push(price)
      return Response.json(price)
    })
    await provisionFieldCatalog("sk_test_not_real")
    vi.resetModules()
    await provisionFieldCatalog("sk_test_not_real")
    expect(writes).toEqual(["/v1/products", "/v1/prices", "/v1/prices"])
    expect(prices.map(p => [p.unit_amount, p.recurring])).toEqual([
      [60000, { interval: "month", interval_count: 1 }],
      [600000, { interval: "year", interval_count: 1 }],
    ])
  })
})
