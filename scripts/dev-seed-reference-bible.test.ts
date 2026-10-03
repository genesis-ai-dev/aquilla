// @vitest-environment node
// AQU-1573: the demo seed's own logic against an in-memory stand-in for the
// dev stack's routes: a first run builds everything, a second run changes
// nothing, a hand-edited draft is put back with an ordinary commit on the
// current head, a deleted demo file is replaced by a fresh copy, and the
// lane, settings and API token are created once. (The real routes are covered
// by their own tests; the live run is part of the PR's QA walk.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { buildDemoRows, demoFileId, DEMO_PROJECT_ID } from "./reference-bible-demo"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 1 })) }))

const IDENTITY = "http://identity.test"
const SYNC = "http://sync.test"

interface Cell { fileId: string; cellId: string; side: "source" | "target"; targetLang: string; value: string; eventId: string }

/** Just enough of auth-worker + sync-worker for the seed's calls. */
class FakeStack {
  bibles = ["arb-vandyck", "eng-kjv"]
  projects = new Set<string>()
  settings: Record<string, unknown> = {}
  version = 0
  lanes: { id: string; role: string; name: string; legacyTag: string | null; archivedAt: string | null }[] = [
    { id: "lane-default", role: "target", name: "Target", legacyTag: "", archivedAt: null },
  ]
  files = new Map<string, { deleted: boolean }>()
  cells: Cell[] = []
  credentials: { id: string; name: string; revokedAt: string | null }[] = []
  members = new Map<string, number>()
  calls: string[] = []
  eventsPosted: { cellId: string; parentId: string; payload: { value: string; targetLang?: string } }[][] = []

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const route = `${method} ${url.origin === IDENTITY ? "id" : "sync"}${url.pathname}${url.search}`
    this.calls.push(route)
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
    const p = `/api/v2/projects/${DEMO_PROJECT_ID}`

    if (route === "POST id/__dev__/login") return json({ access_token: "jwt", username: "dev", org: { id: 7 } })
    if (route === "GET id/api/v2/reference-bibles") return json({ versions: this.bibles.map((id) => ({ id })) })
    if (route === "POST id/api/v2/projects") {
      this.projects.add(body.id)
      return json({ id: body.id })
    }
    if (route === `GET id${p}/settings`) return json({ settings: this.settings, version: this.version, lanes: this.lanes })
    if (route === `PUT id${p}/settings`) {
      if (body.ifMatchVersion !== this.version) return json({ error: "version mismatch" }, 409)
      this.settings = body.settings
      this.version++
      return json({ ok: true })
    }
    if (route === `POST id${p}/lanes`) {
      this.lanes.push({ id: `lane-${body.language}`, role: "target", name: body.name, legacyTag: body.language, archivedAt: null })
      this.settings = { ...this.settings, targetLanes: [...((this.settings.targetLanes as string[]) ?? []), body.language] }
      this.version++
      return json({ lane: this.lanes.at(-1) }, 201)
    }
    if (route === `POST id${p}/members`) {
      this.members.set(body.username, body.role)
      return json({ username: body.username, role: { level: body.role } })
    }
    const archive = new RegExp(`^POST id${p}/lanes/([^/]+)/archive$`).exec(route)
    if (archive) {
      const lane = this.lanes.find((l) => l.id === archive[1])!
      lane.archivedAt = body.archived ? "2026-10-02" : null
      return json({ lane })
    }
    if (route === "POST id/api/v2/sync-token") return json({ token: `sync:${body.fileId}` })
    if (route === `GET sync/api/v1/projects/${DEMO_PROJECT_ID}/files`) {
      return json({ files: [...this.files].filter(([, f]) => !f.deleted).map(([fileId]) => ({ fileId })) })
    }
    if (route === `GET sync/api/v1/projects/${DEMO_PROJECT_ID}/files?trash=1`) {
      return json({ files: [...this.files].filter(([, f]) => f.deleted).map(([fileId]) => ({ fileId })) })
    }
    if (route === "POST sync/import") {
      if (body.file) this.files.set(body.fileId, { deleted: false })
      for (const c of body.cells) {
        this.cells.push({ fileId: body.fileId, cellId: c.cellId, side: "source", targetLang: "", value: c.value, eventId: c.id })
      }
      for (const t of body.targets ?? []) {
        expect(this.cells.find((c) => c.cellId === t.cellId && c.side === "source")?.eventId).toBe(t.parentId)
        this.cells.push({ fileId: body.fileId, cellId: t.cellId, side: "target", targetLang: t.targetLang ?? "", value: t.value, eventId: t.id })
      }
      return json({ ok: true })
    }
    const cellsRead = new RegExp(`^GET sync/api/v1/projects/${DEMO_PROJECT_ID}/files/([^/]+)/cells`).exec(route)
    if (cellsRead) return json({ cells: this.cells.filter((c) => c.fileId === cellsRead[1]) })
    if (route === "POST sync/events") {
      this.eventsPosted.push(body.events)
      const stale: string[] = []
      for (const e of body.events) {
        const lane = e.payload.targetLang ?? ""
        const head = this.cells.find((c) => c.fileId === e.fileId && c.cellId === e.cellId && c.side === "target" && c.targetLang === lane)
        const source = this.cells.find((c) => c.fileId === e.fileId && c.cellId === e.cellId && c.side === "source")!
        if ((head?.eventId ?? source.eventId) !== e.parentId) {
          stale.push(e.id)
          continue
        }
        if (head) Object.assign(head, { value: e.payload.value, eventId: e.id })
        else this.cells.push({ fileId: e.fileId, cellId: e.cellId, side: "target", targetLang: lane, value: e.payload.value, eventId: e.id })
      }
      return json({ accepted: body.events.length - stale.length, stale, rejected: [] })
    }
    if (route === "GET id/api/v2/credentials") return json({ credentials: this.credentials })
    if (route === "POST id/api/v2/credentials") {
      this.credentials.push({ id: `cred-${this.credentials.length + 1}`, name: body.name, revokedAt: null })
      return json({ token: `aqk_${this.credentials.length}` }, 201)
    }
    const revoke = /^DELETE id\/api\/v2\/credentials\/(.+)$/.exec(route)
    if (revoke) {
      this.credentials.find((c) => c.id === revoke[1])!.revokedAt = "now"
      return json({ ok: true })
    }
    return json({ error: `fake stack has no route ${route}` }, 404)
  }

  target(fileId: string, cellId: string, lane = ""): string | undefined {
    return this.cells.find((c) => c.fileId === fileId && c.cellId === cellId && c.side === "target" && c.targetLang === lane)?.value
  }
}

let stack: FakeStack
let output: string[]

async function seed(): Promise<void> {
  vi.resetModules()
  const { main } = await import("./dev-seed-reference-bible")
  await main()
}

beforeEach(() => {
  process.env.DEV_SEED_IDENTITY_BASE = IDENTITY
  process.env.DEV_SEED_SYNC_BASE = SYNC
  stack = new FakeStack()
  output = []
  vi.spyOn(globalThis, "fetch").mockImplementation(stack.handle as typeof fetch)
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void output.push(args.join(" ")))
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.DEV_SEED_IDENTITY_BASE
  delete process.env.DEV_SEED_SYNC_BASE
})

const rows = buildDemoRows()

describe("dev-seed-reference-bible (AQU-1573)", () => {
  it("builds the project, lane, settings and file on a fresh stack", async () => {
    await seed()
    expect(stack.projects).toEqual(new Set([DEMO_PROJECT_ID]))
    expect(stack.settings).toMatchObject({
      sourceLanguage: "English",
      targetLanguage: "Arabic",
      bibleResourcesEnabled: false,
      targetLanes: ["en"],
      referenceBibleVersions: { "": "arb-vandyck", en: "eng-kjv" },
    })
    expect(stack.lanes.filter((l) => l.legacyTag === "en")).toHaveLength(1)
    expect(stack.members).toEqual(new Map([["carol", 400]]))
    const fileId = demoFileId(0)
    for (const row of rows) {
      expect(stack.target(fileId, row.cellId), `row ${row.n}`).toBe(row.targets[""] || undefined)
      expect(stack.target(fileId, row.cellId, "en"), `row ${row.n} en`).toBe(row.targets.en || undefined)
    }
    expect(output.join("\n")).toContain(`/project/${DEMO_PROJECT_ID}/editor/file/${fileId}`)
    expect(output.join("\n")).toContain("Bearer aqk_1")
    expect(output.join("\n")).toContain("__dev/login?as=carol")
  })

  it("changes nothing on a second run, and replaces the demo token", async () => {
    await seed()
    const imports = stack.calls.filter((c) => c === "POST sync/import").length
    await seed()
    expect(stack.calls.filter((c) => c === "POST sync/import").length).toBe(imports)
    expect(stack.eventsPosted).toEqual([])
    expect(stack.lanes.filter((l) => l.legacyTag === "en")).toHaveLength(1)
    expect(stack.credentials.map((c) => c.revokedAt === null)).toEqual([false, true])
  })

  it("puts a hand-edited draft back with a commit on the current head", async () => {
    await seed()
    const fileId = demoFileId(0)
    const row6 = stack.cells.find((c) => c.cellId === rows[5].cellId && c.side === "target" && c.targetLang === "")!
    Object.assign(row6, { value: "edited by a tester", eventId: "evt-tester" })
    const row3 = { fileId, cellId: rows[2].cellId, side: "target" as const, targetLang: "", value: "a draft", eventId: "evt-draft" }
    stack.cells.push(row3)
    await seed()
    expect(stack.eventsPosted).toHaveLength(1)
    const sent = stack.eventsPosted[0]
    expect(sent.map((e) => [e.cellId, e.parentId, e.payload.value])).toEqual([
      [rows[2].cellId, "evt-draft", ""],
      [rows[5].cellId, "evt-tester", rows[5].targets[""]],
    ])
    expect(stack.target(fileId, rows[5].cellId)).toBe(rows[5].targets[""])
  })

  it("brings back an archived Plain English lane", async () => {
    await seed()
    stack.lanes.find((l) => l.legacyTag === "en")!.archivedAt = "2026-10-02"
    await seed()
    expect(stack.lanes.find((l) => l.legacyTag === "en")!.archivedAt).toBeNull()
  })

  it("seeds a fresh copy when the demo file was deleted", async () => {
    await seed()
    stack.files.get(demoFileId(0))!.deleted = true
    await seed()
    expect(stack.files.get(demoFileId(1))).toEqual({ deleted: false })
    const fresh = buildDemoRows(undefined, 1)
    expect(stack.target(demoFileId(1), fresh[3].cellId)).toBe(fresh[3].targets[""])
    expect(output.join("\n")).toContain(`/editor/file/${demoFileId(1)}`)
  })

  it("loads missing Bibles first, and stops with a plain message when they still are not there", async () => {
    stack.bibles = []
    process.env.AQUILLA_DATABASE_URL = "postgresql://nobody:secret@127.0.0.1:1/none"
    vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(seed()).rejects.toThrow(/still has no arb-vandyck, eng-kjv after the loader ran/)
    } finally {
      delete process.env.AQUILLA_DATABASE_URL
    }
    expect(stack.projects.size).toBe(0)
    expect(output.join("\n")).toContain("postgresql://nobody:***@127.0.0.1:1/none")
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "npx",
      ["tsx", "scripts/reference-bibles.ts", "load", "--if-missing"],
      expect.objectContaining({ env: expect.objectContaining({ AQUILLA_DATABASE_URL: "postgresql://nobody:secret@127.0.0.1:1/none" }) }),
    )
  })
})
