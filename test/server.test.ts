import { createServer } from "node:http"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Workspace } from "../src/ambient/workspace.ts"
import { createHandler } from "../src/ambient/server.ts"
import { brochureSpec, buildIdml } from "../src/fixtures/build-idml.ts"
import { idmlAdapter } from "../src/adapters/idml/index.ts"

let dir: string
let server: Server
let base: string
// Test-only: loosely typed JSON responses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const J = async (r: Response | Promise<Response>): Promise<any> => (await r).json()

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ambient-srv-"))
  const ws = Workspace.init(dir, { sourceLocale: "en", targets: ["fr"], translator: "pseudo" })
  writeFileSync(join(dir, "brochure.idml"), buildIdml(brochureSpec()))
  writeFileSync(join(dir, "notes.md"), "# Hello\n\nA short note about the choir.\n")
  await ws.sync()
  const handle = createHandler(Workspace.open(dir, "ui-user"))
  server = createServer((req, res) => void handle(req, res))
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("inspector server", () => {
  it("serves the UI and status", async () => {
    expect((await (await fetch(`${base}/`)).text())).toContain("Ambient Inspector")
    const s = await J(fetch(`${base}/api/status`))
    expect(s.docs.map((d: { docId: string }) => d.docId)).toEqual(["brochure.idml", "notes.md"])
  })
  it("edits from the UI become human decisions that sync publishes", async () => {
    const view = await J(fetch(`${base}/api/doc?doc=notes.md`))
    const unit = view.units[1].logicalId
    const r = await fetch(`${base}/api/edit`, { method: "POST", body: JSON.stringify({ doc: "notes.md", unit, locale: "fr", text: "Une petite note sur la chorale." }) })
    expect(r.status).toBe(200)
    await fetch(`${base}/api/sync`, { method: "POST", body: "{}" })
    const after = await J(fetch(`${base}/api/doc?doc=notes.md`))
    expect(after.units[1].targets.fr).toMatchObject({ text: "Une petite note sur la chorale.", authority: "human" })
  })
  it("downloads any file in any language, translating on demand", async () => {
    const r = await fetch(`${base}/files/sw/brochure.idml`)
    expect(r.status).toBe(200)
    const bytes = new Uint8Array(await r.arrayBuffer())
    expect(idmlAdapter.extract(bytes, "x").units[0]!.plain).toContain("⟦sw⟧")
  })
  it("exposes a WebDAV drive with lazy language folders", async () => {
    const root = await (await fetch(`${base}/dav/`, { method: "PROPFIND", headers: { depth: "1" } })).text()
    expect(root).toContain("/dav/fr/")
    const ja = await fetch(`${base}/dav/ja/`, { method: "PROPFIND", headers: { depth: "1" } })
    expect(ja.status).toBe(207)
    expect(await ja.text()).toContain("/dav/ja/notes.md")
    const md = await (await fetch(`${base}/dav/ja/notes.md`)).text()
    expect(md).toContain("⟦ja⟧")
    expect((await fetch(`${base}/dav/../../etc/passwd`)).status).toBe(404)
  })
  it("rejects bad input with a clear error", async () => {
    const r = await fetch(`${base}/api/edit`, { method: "POST", body: JSON.stringify({ doc: "notes.md" }) })
    expect(r.status).toBe(400)
    expect((await J(r)).error).toMatch(/missing/)
  })
})
