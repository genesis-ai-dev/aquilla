// Monday rows named after the project, and files as subitems of that row.
//
// A board linked through "Set up with AI" showed its project's row as
// "{{project_name}}": the AI wrote the template in a syntax nothing filled in.
// And a project's files had nowhere to go but rows of their own, which buried
// the project's overall number; now they can be subitems of its row.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { encryptMondayToken } from "../lib/monday/crypto"
import { pushBoardLink } from "../lib/monday/push"
import { parseJsonColumn, sanitizeMapping, type IntegrationLinkRow, type MondayMapping } from "../lib/monday/types"
import { canonicalItemNameTemplate, renderItemName } from "../lib/integrations/item-name"
import type { Env } from "../types"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("item names", () => {
  it("fills in the project's name however the placeholder is spelled", () => {
    for (const template of ["{projectName}", "{{project_name}}", "{{ projectName }}", "{project name}", "{{PROJECT}}"]) {
      expect(renderItemName(template, "project", "LAN Party")).toBe("LAN Party")
    }
    expect(renderItemName("{{project_name}} — {{file_name}}", "file", "LAN Party", "Mark")).toBe("LAN Party — Mark")
  })

  it("names the row by default when the template names anything else or comes out empty", () => {
    expect(renderItemName("{{client}} translation", "project", "LAN Party")).toBe("LAN Party")
    expect(renderItemName("{fileName}", "project", "LAN Party")).toBe("LAN Party")
    expect(renderItemName(undefined, "file", "LAN Party", "Mark")).toBe("LAN Party — Mark")
    expect(canonicalItemNameTemplate("{{client}}")).toBeNull()
  })

  it("stores the template in its one written form, and drops one nothing fills in", () => {
    const base = { version: 1, itemGranularity: "project", columns: [] }
    expect(sanitizeMapping({ ...base, itemNameTemplate: "{{project_name}}" }).mapping?.itemNameTemplate).toBe(
      "{projectName}",
    )
    const dropped = sanitizeMapping({ ...base, itemNameTemplate: "{{client}}" })
    expect(dropped.mapping?.itemNameTemplate).toBeUndefined()
    expect(dropped.warnings.join()).toMatch(/itemNameTemplate/)
  })
})

describe("sanitizeMapping: fileSubitems", () => {
  it("keeps them under one item per project, with only the columns a file has its own value for", () => {
    const { mapping } = sanitizeMapping({
      version: 1,
      itemGranularity: "project",
      columns: [],
      fileSubitems: {
        boardId: "777",
        columns: [
          { columnId: "numeric_c", columnType: "numbers", metric: "completion_pct" },
          { columnId: "text_l", columnType: "text", metric: "languages" },
          { columnId: "text_aq", columnType: "text", metric: "external_id" },
        ],
      },
    })
    expect(mapping?.fileSubitems).toEqual({
      boardId: "777",
      columns: [
        { columnId: "numeric_c", columnType: "numbers", metric: "completion_pct" },
        { columnId: "text_aq", columnType: "text", metric: "external_id" },
      ],
    })
  })

  it("drops them when every file is a row of its own", () => {
    const { mapping, warnings } = sanitizeMapping({
      version: 1,
      itemGranularity: "file",
      columns: [],
      fileSubitems: { columns: [] },
    })
    expect(mapping?.fileSubitems).toBeUndefined()
    expect(warnings.join()).toMatch(/fileSubitems/)
  })
})

// ── Push ──────────────────────────────────────────────────────────────────

const PARENT_COLUMNS = [
  { columnId: "name", columnType: "name", metric: "project_name" },
  { columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" },
  { columnId: "status", columnType: "status", metric: "status_auto" },
  { columnId: "text_lang", columnType: "text", metric: "languages" },
]

async function seed(config: Partial<MondayMapping>): Promise<IntegrationLinkRow> {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'LAN Party', 1, 1)",
  ).run()
  for (const [id, name, filled] of [["file-a", "Mark", 5], ["file-b", "1 Peter", 0]] as const) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count)
       VALUES (?, 'proj-1', ?, ?, 10, ?, 0)`,
    )
      .bind(id, name, `ev-${id}`, filled)
      .run()
  }
  const accessEnc = await encryptMondayToken(env.SECRET_KEY, "monday-plain-token")
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_connections (id, org_id, provider, account, access_token_enc, created_by, environment)
     VALUES ('conn-1', '1', 'monday', '{"accountSlug":"acme"}', ?, 'wendi', 'test')`,
  )
    .bind(accessEnc)
    .run()
  const full = { version: 1, itemGranularity: "project", columns: PARENT_COLUMNS, ...config }
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_links (id, project_id, provider, connection_id, external_id, external_name, config, created_by)
     VALUES ('link-1', 'proj-1', 'monday', 'conn-1', 'board-9', 'Test Board', ?, 'wendi')`,
  )
    .bind(JSON.stringify(full))
    .run()
  // The project's row is already on the board.
  await env.AQUILLA_PG.prepare(
    "INSERT INTO integration_item_links (link_id, entity_kind, entity_id, external_item_id) VALUES ('link-1', 'project', 'proj-1', '500')",
  ).run()
  return readLink()
}

const readLink = async () =>
  (await env.AQUILLA_PG.prepare("SELECT * FROM integration_links WHERE id = 'link-1'").first<IntegrationLinkRow>())!

/** Answers Monday GraphQL by what the query asks; records every query. */
function mockMonday(responder: (query: string) => unknown) {
  const queries: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (!url.startsWith("https://api.monday.com/v2")) throw new Error(`unexpected fetch in test: ${url}`)
      const query = String(JSON.parse(String(init?.body)).query)
      queries.push(query)
      const data = responder(query)
      if (data === undefined) throw new Error(`unexpected Monday query in test: ${query.slice(0, 160)}`)
      return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } })
    }),
  )
  return queries
}

/** Aliased mutation answers: every alias in the query → `{ id }` (plus a board for subitems). */
function aliased(query: string, prefix: string, board?: string) {
  const aliases = [...query.matchAll(new RegExp(`\\b(${prefix}\\d+):`, "g"))].map((m) => m[1])
  return Object.fromEntries(aliases.map((a, i) => [a, { id: `${prefix}-${i}`, ...(board && { board: { id: board } }) }]))
}

const subitemLinks = async () =>
  (
    await env.AQUILLA_PG.prepare(
      "SELECT entity_id, external_item_id FROM integration_item_links WHERE link_id = 'link-1' AND entity_kind = 'subitem' ORDER BY entity_id",
    ).all<{ entity_id: string; external_item_id: string }>()
  ).results ?? []

describe("push: the project's row", () => {
  it("is named after the project when the AI wrote {{project_name}}", async () => {
    const link = await seed({ itemNameTemplate: "{{project_name}}" })
    const queries = mockMonday((q) => (q.includes("change_multiple_column_values") ? aliased(q, "u") : undefined))

    expect((await pushBoardLink(env as unknown as Env, link)).ok).toBe(true)
    const update = queries.find((q) => q.includes("change_multiple_column_values"))!
    expect(update).toContain("LAN Party")
    expect(update).not.toContain("project_name}}")
  })
})

describe("push: files as subitems", () => {
  it("adds the subitem columns once, creates a subitem per file with its own values, and remembers both", async () => {
    const link = await seed({ fileSubitems: { columns: [] } })
    const created: string[] = []
    const queries = mockMonday((q) => {
      if (q.includes("change_multiple_column_values")) return aliased(q, "u")
      if (q.includes("subitems {")) return { items: [{ subitems: [] }] }
      if (q.includes("columns(types: [subtasks])")) {
        return { boards: [{ columns: [{ settings_str: JSON.stringify({ boardIds: [777] }) }] }] }
      }
      if (q.includes('boards(ids: "777")')) {
        return {
          boards: [
            {
              name: "Subitems of Test Board",
              url: null,
              columns: [
                { id: "name", title: "Subitem", type: "name" },
                { id: "status", title: "Status", type: "status" },
              ],
              groups: [],
            },
          ],
        }
      }
      if (q.includes("create_column")) {
        const title = /title: "([^"]+)"/.exec(q)![1]
        created.push(title)
        return { create_column: { id: `col_${created.length}`, title, type: title === "Aquilla ID" ? "text" : "numbers" } }
      }
      if (q.includes("create_subitem")) return aliased(q, "s", "777")
      return undefined
    })

    const result = await pushBoardLink(env as unknown as Env, link)
    expect(result).toMatchObject({ ok: true, itemsUpserted: 3 })

    // Monday's own Status column is used; Completion % and Aquilla ID are added.
    expect(created).toEqual(["Completion %", "Aquilla ID"])
    const subitemCreates = queries.filter((q) => q.includes("create_subitem"))
    expect(subitemCreates).toHaveLength(1)
    expect(subitemCreates[0]).toContain('parent_item_id: "500"')
    expect(subitemCreates[0]).toContain('item_name: "Mark"')
    expect(subitemCreates[0]).toContain('item_name: "1 Peter"')
    // Mark: 5 of 10 lines → 50, In progress; values go with the subitem.
    expect(subitemCreates[0]).toContain('\\"col_1\\":\\"50\\"')
    expect(subitemCreates[0]).toContain('\\"status\\":{\\"label\\":\\"In progress\\"}')
    expect(subitemCreates[0]).toContain('\\"col_2\\":\\"file-a\\"')

    // Files go in name order: 1 Peter, then Mark.
    expect(await subitemLinks()).toEqual([
      { entity_id: "file-a", external_item_id: "s-1" },
      { entity_id: "file-b", external_item_id: "s-0" },
    ])
    const config = parseJsonColumn<MondayMapping>((await readLink()).config, null as never)
    expect(config.fileSubitems).toEqual({
      boardId: "777",
      columns: [
        { columnId: "col_1", columnType: "numbers", metric: "completion_pct" },
        { columnId: "status", columnType: "status", metric: "status_auto" },
        { columnId: "col_2", columnType: "text", metric: "external_id" },
      ],
    })

    // The next push only writes values, on the subitems board, names included.
    const next = mockMonday((q) => {
      if (q.includes("change_multiple_column_values")) return aliased(q, q.includes("v0:") ? "v" : "u")
      if (q.includes("subitems {")) {
        return {
          items: [
            {
              subitems: [
                { id: "s-0", name: "1 Peter", board: { id: "777" }, column_values: [{ id: "col_2", text: "file-b" }] },
                { id: "s-1", name: "Mark", board: { id: "777" }, column_values: [{ id: "col_2", text: "file-a" }] },
              ],
            },
          ],
        }
      }
      return undefined
    })
    expect((await pushBoardLink(env as unknown as Env, await readLink())).ok).toBe(true)
    const writes = next.filter((q) => q.includes('board_id: "777"'))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('item_id: "s-0"')
    expect(writes[0]).toContain('\\"name\\":\\"1 Peter\\"')
    expect(next.some((q) => q.includes("create_column") || q.includes("create_subitem"))).toBe(false)
  })

  it("makes the subitems first on a board that has no subitems board yet, then fills them in", async () => {
    const link = await seed({ fileSubitems: { columns: [] } })
    const queries = mockMonday((q) => {
      if (q.includes("change_multiple_column_values")) return aliased(q, q.includes("v0:") ? "v" : "u")
      if (q.includes("subitems {")) return { items: [{ subitems: [] }] }
      if (q.includes("columns(types: [subtasks])")) return { boards: [{ columns: [] }] }
      if (q.includes("create_subitem")) return aliased(q, "s", "778")
      if (q.includes('boards(ids: "778")')) {
        return {
          boards: [
            {
              columns: [
                { id: "status", title: "Status", type: "status" },
                { id: "numeric_c", title: "Completion %", type: "numbers" },
                { id: "text_aq", title: "Aquilla ID", type: "text" },
              ],
              groups: [],
            },
          ],
        }
      }
      return undefined
    })

    expect((await pushBoardLink(env as unknown as Env, link)).ok).toBe(true)
    // Created with names only, then written once the board is known.
    const create = queries.find((q) => q.includes("create_subitem"))!
    expect(create).toContain('column_values: "{}"')
    const fill = queries.find((q) => q.includes('board_id: "778"'))!
    expect(fill).toContain('\\"numeric_c\\":\\"50\\"')
    expect(queries.some((q) => q.includes("create_column"))).toBe(false)
    expect((await subitemLinks()).map((r) => r.entity_id)).toEqual(["file-a", "file-b"])
  })

  it("adopts a subitem already under the row instead of adding a second one", async () => {
    const link = await seed({
      fileSubitems: {
        boardId: "777",
        columns: [
          { columnId: "numeric_c", columnType: "numbers", metric: "completion_pct" },
          { columnId: "text_aq", columnType: "text", metric: "external_id" },
        ],
      },
    })
    const queries = mockMonday((q) => {
      if (q.includes("change_multiple_column_values")) return aliased(q, q.includes("v0:") ? "v" : "u")
      if (q.includes("subitems {")) {
        return { items: [{ subitems: [{ id: "old-1", name: "Mark", board: { id: "777" }, column_values: [{ id: "text_aq", text: "file-a" }] }] }] }
      }
      if (q.includes("create_subitem")) return aliased(q, "s", "777")
      return undefined
    })

    expect((await pushBoardLink(env as unknown as Env, link)).ok).toBe(true)
    const create = queries.find((q) => q.includes("create_subitem"))!
    expect(create).toContain('item_name: "1 Peter"')
    expect(create).not.toContain('item_name: "Mark"')
    expect(await subitemLinks()).toEqual([
      { entity_id: "file-a", external_item_id: "old-1" },
      { entity_id: "file-b", external_item_id: "s-0" },
    ])
  })
})

// ── Route: the switch ─────────────────────────────────────────────────────

const menv = { ...env, MONDAY_CLIENT_ID: "id", MONDAY_CLIENT_SECRET: "secret", MONDAY_SIGNING_SECRET: "signing" }

const patch = async (body: unknown) =>
  app.request(
    "/api/v2/monday/projects/proj-1/link",
    { method: "PATCH", headers: authHeader(await jwtFor("anna")), body: JSON.stringify(body) },
    menv,
  )

describe("PATCH link: fileSubitems", () => {
  it("turns them on and pushes, and a mapping saved afterwards keeps them", async () => {
    await seed({})
    mockMonday((q) => {
      if (q.includes("change_multiple_column_values")) return aliased(q, q.includes("v0:") ? "v" : "u")
      if (q.includes("subitems {")) return { items: [{ subitems: [] }] }
      if (q.includes("columns(types: [subtasks])")) return { boards: [{ columns: [] }] }
      if (q.includes("create_subitem")) return aliased(q, "s", "778")
      if (q.includes('boards(ids: "778")')) return { boards: [{ columns: [{ id: "status", title: "Status", type: "status" }], groups: [] }] }
      if (q.includes("create_column")) return { create_column: { id: "col_x", title: "x", type: "numbers" } }
      if (q.includes('boards(ids: "board-9")')) {
        return {
          boards: [
            {
              name: "Test Board",
              url: null,
              columns: [
                { id: "name", title: "Name", type: "name" },
                { id: "numbers_1", title: "Completion %", type: "numbers" },
                { id: "status", title: "Status", type: "status" },
                { id: "text_lang", title: "Languages", type: "text" },
              ],
              groups: [],
            },
          ],
        }
      }
      return undefined
    })

    const on = await patch({ fileSubitems: true })
    expect(on.status).toBe(200)
    const body = (await on.json()) as { link: { config: MondayMapping }; push?: { ok: boolean; itemsUpserted?: number } }
    expect(body.push).toMatchObject({ ok: true, itemsUpserted: 3 })
    expect(body.link.config.fileSubitems?.boardId).toBe("778")

    // The AI's proposal (or a hand-saved mapping) knows nothing of subitems.
    const saved = await patch({ config: { version: 1, itemGranularity: "project", columns: PARENT_COLUMNS } })
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as { link: { config: MondayMapping } }).link.config.fileSubitems?.boardId).toBe("778")

    const off = await patch({ fileSubitems: false })
    expect(((await off.json()) as { link: { config: MondayMapping } }).link.config.fileSubitems).toBeUndefined()
  })
})
