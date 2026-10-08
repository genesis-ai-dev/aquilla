// Tools builder gates: what a model reply must look like to be saved, and the
// repair message a failing reply produces. The model is a stub fetch — the
// contract under test is parse → manifest → lint, not the model.

import { describe, it, expect } from "vitest"
import { runBuild, TOOLS_BUILDER_MODEL } from "../lib/tools/builder"
import { buildUserMessage, parseBuildReply } from "../lib/tools/build-prompt"

function stubFetch(content: string, cost = 0.12): { fetchImpl: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = []
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")))
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }) as typeof fetch
  return { fetchImpl, bodies }
}

const reply = (manifest: object, html: string) =>
  "Here you go.\n```json\n" + JSON.stringify(manifest) + "\n```\n```html\n" + html + "\n```\n"

const MANIFEST = { name: "Grid", description: "a grid", scopes: ["read:cells"], mounts: ["page"] }

describe("tools builder", () => {
  it("accepts a clean reply and reports cost", async () => {
    const { fetchImpl, bodies } = stubFetch(reply(MANIFEST, "<div></div><script>aquilla.files.list()</script>"))
    const out = await runBuild({ OPENROUTER_API_KEY: "k" }, { request: "a grid" }, fetchImpl)
    expect(out.ok).toBe(true)
    expect(out.usage.cost).toBeCloseTo(0.12)
    expect(out.model).toBe(TOOLS_BUILDER_MODEL)
    expect((bodies[0] as { model: string }).model).toBe("anthropic/claude-opus-5.5")
  })

  it("fails lint on banned globals and returns a repair message naming them", async () => {
    const { fetchImpl } = stubFetch(reply(MANIFEST, `<script>fetch("https://x");eval("1")</script>`))
    const out = await runBuild({ OPENROUTER_API_KEY: "k" }, { request: "a grid" }, fetchImpl)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure).toMatch(/fetch\(\) is not available/)
    expect(out.failure).toMatch(/eval\(\) is banned/)
    expect(out.source).toContain("fetch")
  })

  it("fails on an unknown scope", async () => {
    const { fetchImpl } = stubFetch(reply({ ...MANIFEST, scopes: ["write:everything"] }, "<script></script>"))
    const out = await runBuild({ OPENROUTER_API_KEY: "k" }, { request: "x" }, fetchImpl)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure).toMatch(/unknown scope: write:everything/)
  })

  it("fails when the reply has no blocks", async () => {
    expect(parseBuildReply("sorry")).toEqual({ error: "reply had no ```json manifest block" })
  })

  it("puts the previous attempt and failure into the repair prompt", () => {
    const msg = buildUserMessage("a grid", { previousSource: "<p>old</p>", previousManifest: "{}", failure: "smoke: boom" })
    expect(msg).toContain("smoke: boom")
    expect(msg).toContain("<p>old</p>")
  })
})
