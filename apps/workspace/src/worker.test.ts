import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import worker from "./worker"

function expectedInlineScriptHash(): string {
  const indexPath = [
    join(process.cwd(), "index.html"),
    join(process.cwd(), "apps/workspace/index.html"),
  ].find((path) => existsSync(path))
  if (!indexPath) throw new Error("workspace index.html was not found")

  const html = readFileSync(indexPath, "utf8")
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error("workspace index.html has no inline bootstrap script")
  return `'sha256-${createHash("sha256").update(script).digest("base64")}'`
}

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
    expect(csp).toContain(expectedInlineScriptHash())
    expect(csp).toContain("https://static.cloudflareinsights.com")
  })
})
