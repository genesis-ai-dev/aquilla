import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildMcpServer } from "../src/ambient/mcp.ts"
import { Workspace } from "../src/ambient/workspace.ts"

let dir: string
let client: Client

const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const r = await client.callTool({ name, arguments: args })
  const content = r.content as Array<{ type: string; text: string }>
  return JSON.parse(content[0]!.text)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ambient-mcp-"))
  Workspace.init(dir, { sourceLocale: "en", targets: ["fr"], translator: "pseudo" })
  writeFileSync(join(dir, "faq.md"), "# FAQ\n\nWhere is the church hall?\n\nThe church hall is behind the library.\n")
  const [a, b] = InMemoryTransport.createLinkedPair()
  await buildMcpServer(dir).connect(a)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(b)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("MCP agent surface", () => {
  it("lists the tools an agent needs", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name)
    expect(tools).toEqual(expect.arrayContaining(["ambient_status", "ambient_sync", "ambient_units", "ambient_edit", "ambient_add_term", "ambient_open", "ambient_view"]))
  })
  it("supports a whole conversation: sync, decide a term, re-sync, inspect, view", async () => {
    await call("ambient_sync")
    await call("ambient_add_term", { source: "church hall", target: "salle paroissiale", locale: "fr" })
    const s = (await call("ambient_sync")) as { docs: Array<{ locales: Array<{ translated: number }> }> }
    expect(s.docs[0]!.locales[0]!.translated).toBe(2) // only the two units that mention the term
    const units = (await call("ambient_units", { doc: "faq.md", query: "library" })) as Array<{ targets: { fr: { text: string } } }>
    expect(units).toHaveLength(1)
    expect(units[0]!.targets.fr.text).toContain("salle paroissiale")
    const v = (await call("ambient_view", { doc: "faq.md", query: "church" })) as { path: string; units: number }
    expect(v.units).toBe(2)
    expect(readFileSync(v.path, "utf8")).toContain("salle paroissiale")
    const o = (await call("ambient_open", { doc: "faq.md", locale: "es" })) as { path: string }
    expect(readFileSync(o.path, "utf8")).toContain("⟦es⟧")
  })
})
