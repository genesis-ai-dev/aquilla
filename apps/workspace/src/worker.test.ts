import { describe, expect, it } from "vitest"
import worker from "./worker"

describe("workspace worker", () => {
  it("sets CSP for the workspace shell scripts", async () => {
    const env = {
      ENV: "prod",
      ASSETS: {
        fetch: async (req: Request) => {
          const url = new URL(req.url)
          if (url.pathname === "/w/") {
            return new Response("<!doctype html>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          }
          return new Response("not found", { status: 404 })
        },
      },
    }

    const res = await worker.fetch(
      new Request("https://aquilla.app/w/4269fb81-dc64-4c2a-a5d8-a6f20aa96414"),
      env,
    )
    const csp = res.headers.get("content-security-policy")

    expect(res.status).toBe(200)
    expect(csp).toContain("'sha256-74Xvtgz3gPUBIG0h/Kc709HVgoSH9YKOa6ntsFzZ1mg='")
    expect(csp).toContain("https://static.cloudflareinsights.com")
  })
})
