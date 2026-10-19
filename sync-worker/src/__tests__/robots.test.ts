import { describe, it, expect } from "vitest"
import { handleRobotsTxt } from "../robots"

// Agent fetch tools read https://api.aquilla.app/robots.txt before calling the
// Agent API. Before this route existed the host answered with a Cloudflare 522,
// and RFC 9309 tells crawlers to treat a 5xx robots.txt as "disallow
// everything" — so agents refused to connect at all.
describe("handleRobotsTxt", () => {
  const get = (path: string, method = "GET") =>
    handleRobotsTxt(new Request(`https://api.aquilla.app${path}`, { method }))

  it("answers 200 so agent fetchers do not read the host as fully disallowed", async () => {
    const res = get("/robots.txt")
    expect(res?.status).toBe(200)
    expect(res?.headers.get("Content-Type")).toMatch(/^text\/plain/)
  })

  it("allows every path, including the Agent API under /sync/api/v1/external", async () => {
    const body = await get("/robots.txt")!.text()
    expect(body).toMatch(/^User-agent: \*$/m)
    expect(body).toMatch(/^Allow: \/$/m)
    expect(body).not.toMatch(/^Disallow: *\S/m)
  })

  it("answers HEAD too", () => {
    expect(get("/robots.txt", "HEAD")?.status).toBe(200)
  })

  it("leaves every other path to the router", () => {
    expect(get("/api/v1/external")).toBeNull()
    expect(get("/robots.txt", "POST")).toBeNull()
  })
})
