import { describe, expect, it } from "vitest"
import { probe } from "../src/probe"

const target = { id: "sync", name: "Sync", url: "https://api.aquilla.app/sync/health", expectBodyIncludes: '"ok":true' }
const respond = (body: string, status = 200) => (async () => new Response(body, { status })) as typeof fetch

describe("probe", () => {
  it("passes on the expected status and body", async () => {
    expect(await probe(target, respond('{"ok":true}'))).toMatchObject({ id: "sync", ok: true, status: 200 })
  })

  it("fails on an unexpected status", async () => {
    const result = await probe(target, respond('{"ok":false}', 503))
    expect(result).toMatchObject({ ok: false, status: 503, error: "HTTP 503 (expected 200)" })
  })

  it("fails on a 200 whose body lacks the marker (an error page served as 200)", async () => {
    const result = await probe(target, respond("<html>Cloudflare error</html>"))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/body is missing/)
  })

  it("fails on a network error", async () => {
    const result = await probe(target, (async () => {
      throw new TypeError("fetch failed")
    }) as typeof fetch)
    expect(result).toMatchObject({ ok: false, error: "fetch failed" })
  })

  it("reports a timeout in plain words", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
      })) as typeof fetch
    const result = await probe({ ...target, timeoutMs: 20 }, hang)
    expect(result).toMatchObject({ ok: false, error: "no response in 0s" })
  })

  it("does not follow redirects, so a redirect to a login page is not 'healthy'", async () => {
    let seen: RequestInit | undefined
    await probe(target, (async (_url: string, init?: RequestInit) => {
      seen = init
      return new Response(null, { status: 302 })
    }) as typeof fetch)
    expect(seen?.redirect).toBe("manual")
  })
})
