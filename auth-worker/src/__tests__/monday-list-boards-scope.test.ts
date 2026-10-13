// AQU-1770 walk (Oct 12): under Monday's OAuth 2.1 flow, reading a board's
// workspace needs workspaces:read. An app without it must still list boards.

import { describe, it, expect, afterEach, vi } from "vitest"
import { listBoards } from "../lib/monday/client"

afterEach(() => {
  vi.unstubAllGlobals()
})

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

describe("listBoards", () => {
  it("lists boards without workspace names when the token lacks workspaces:read", async () => {
    const queries: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string }
      queries.push(query)
      if (query.includes("workspace")) {
        return json({ errors: [{ message: "Unauthorized to load field 'Query.boards.workspace', Reason: missing required scopes." }] })
      }
      return json({ data: { boards: [{ id: 1, name: "Aquilla blank test", state: "active" }] } })
    }))
    const boards = await listBoards("tok")
    expect(boards).toEqual([{ id: "1", name: "Aquilla blank test", workspace: null }])
    expect(queries).toHaveLength(2)
  })

  it("keeps workspace names when the scope is there, and rethrows other errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({ data: { boards: [{ id: 2, name: "Plan", workspace: { id: 9, name: "Main" } }] } })))
    expect(await listBoards("tok")).toEqual([{ id: "2", name: "Plan", workspace: { id: "9", name: "Main" } }])

    vi.stubGlobal("fetch", vi.fn(async () => json({ errors: [{ message: "Not authenticated" }] })))
    await expect(listBoards("tok")).rejects.toThrow("Not authenticated")
  })
})
