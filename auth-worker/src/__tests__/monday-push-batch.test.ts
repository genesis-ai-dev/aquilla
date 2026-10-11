// AQU-1828 — one Monday lookup for the whole push, not one per file.
//
// The regression this guards: upsertEntities resolved pre-existing items with a
// findItemByName / findItemByColumnValue call PER ENTITY, so first-linking a
// 66-book project spent 66 subrequests just matching items — a cron run over
// ~20 such links blew the Workers subrequest ceiling before pushing anything.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import { seedUser } from "./helpers/db"
import { encryptMondayToken } from "../lib/monday/crypto"
import { pushBoardLink } from "../lib/monday/push"
import type { IntegrationLinkRow } from "../lib/monday/types"
import type { Env } from "../types"

afterEach(() => {
  vi.unstubAllGlobals()
})

const BOOKS = [
  "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy",
  "Joshua", "Judges", "Ruth", "1 Samuel", "2 Samuel",
  "1 Kings", "2 Kings",
]

async function seedProjectWithFiles(match: "byName" | "column"): Promise<IntegrationLinkRow> {
  await seedUser(1, "wendi")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'Burmese OT', 1, 1)",
  ).run()
  for (const [i, name] of BOOKS.entries()) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count)
       VALUES (?, 'proj-1', ?, ?, 100, 50, 10)`,
    )
      .bind(`file-${i}`, name, `ev-${i}`)
      .run()
  }
  const accessEnc = await encryptMondayToken(env.SECRET_KEY, "monday-plain-token")
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_connections (id, org_id, provider, account, access_token_enc, created_by)
     VALUES ('conn-1', '1', 'monday', '{"accountSlug":"acme"}', ?, 'wendi')`,
  )
    .bind(accessEnc)
    .run()
  const config = {
    version: 1,
    itemGranularity: "file",
    itemNameTemplate: "{fileName}",
    matchExisting: match === "byName" ? { byName: true } : { columnId: "text_ext" },
    columns: [
      { columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" },
      ...(match === "column"
        ? [{ columnId: "text_ext", columnType: "text", metric: "external_id" }]
        : []),
    ],
  }
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_links (id, project_id, provider, connection_id, external_id, external_name, config, created_by)
     VALUES ('link-1', 'proj-1', 'monday', 'conn-1', 'board-9', 'OT Board', ?, 'wendi')`,
  )
    .bind(JSON.stringify(config))
    .run()
  return (await env.AQUILLA_PG.prepare(
    "SELECT * FROM integration_links WHERE id = 'link-1'",
  ).first<IntegrationLinkRow>())!
}

/** Records every Monday GraphQL query so the test can count lookups vs mutations. */
function mockMonday(responder: (query: string) => unknown) {
  const queries: string[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (!url.startsWith("https://api.monday.com/v2")) {
      throw new Error(`unexpected fetch in test: ${url}`)
    }
    const query = String(JSON.parse(String(init?.body)).query)
    queries.push(query)
    return new Response(JSON.stringify({ data: responder(query) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  })
  vi.stubGlobal("fetch", fn)
  return queries
}

const countMatching = (queries: string[], needle: string) =>
  queries.filter((q) => q.includes(needle)).length

describe("first push over many files", () => {
  it("matches pre-existing items by name with ONE items_page query", async () => {
    const link = await seedProjectWithFiles("byName")
    // Every book already exists on the board, so every entity is a match.
    const queries = mockMonday((query) => {
      if (query.includes("items_page(")) {
        return {
          boards: [
            {
              items_page: {
                items: BOOKS.map((name, i) => ({ id: 500 + i, name })),
              },
            },
          ],
        }
      }
      // Column updates come back aliased u0..uN.
      return Object.fromEntries(BOOKS.map((_, i) => [`u${i}`, { id: String(500 + i) }]))
    })

    const result = await pushBoardLink(env as unknown as Env, link)
    expect(result.ok).toBe(true)
    expect(result.itemsUpserted).toBe(BOOKS.length)

    expect(countMatching(queries, "items_page(")).toBe(1)
    expect(countMatching(queries, "create_item")).toBe(0)

    // Every file is linked to the item it matched.
    const rows = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM integration_item_links WHERE link_id = 'link-1'",
    ).first<{ n: number | string }>()
    expect(Number(rows!.n)).toBe(BOOKS.length)
  })

  it("matches by external-id column with ONE items_page_by_column_values query", async () => {
    const link = await seedProjectWithFiles("column")
    const queries = mockMonday((query) => {
      if (query.includes("items_page_by_column_values")) {
        return {
          items_page_by_column_values: {
            items: BOOKS.map((_, i) => ({
              id: 700 + i,
              column_values: [{ id: "text_ext", text: `file-${i}` }],
            })),
          },
        }
      }
      return Object.fromEntries(BOOKS.map((_, i) => [`u${i}`, { id: String(700 + i) }]))
    })

    const result = await pushBoardLink(env as unknown as Env, link)
    expect(result.ok).toBe(true)
    expect(countMatching(queries, "items_page_by_column_values")).toBe(1)
    expect(countMatching(queries, "create_item")).toBe(0)

    const row = await env.AQUILLA_PG.prepare(
      "SELECT external_item_id FROM integration_item_links WHERE link_id = 'link-1' AND entity_id = 'file-3'",
    ).first<{ external_item_id: string }>()
    expect(row!.external_item_id).toBe("703")
  })

  it("creates the unmatched files in batched mutations, one lookup either way", async () => {
    const link = await seedProjectWithFiles("byName")
    // The board is empty: nothing matches, everything is created.
    const queries = mockMonday((query) => {
      if (query.includes("items_page(")) return { boards: [{ items_page: { items: [] } }] }
      const created: Record<string, { id: string }> = {}
      for (const alias of query.matchAll(/\b(c\d+):/g)) created[alias[1]] = { id: `9${alias[1]}` }
      return created
    })

    const result = await pushBoardLink(env as unknown as Env, link)
    expect(result.ok).toBe(true)
    expect(result.itemsUpserted).toBe(BOOKS.length)

    expect(countMatching(queries, "items_page(")).toBe(1)
    // runAliasedMutations batches ~10 creates per request: 12 files → 2 calls,
    // never one per file.
    expect(countMatching(queries, "create_item")).toBe(2)

    const rows = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM integration_item_links WHERE link_id = 'link-1'",
    ).first<{ n: number | string }>()
    expect(Number(rows!.n)).toBe(BOOKS.length)
  })
})
