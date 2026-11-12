import type { Client } from "pg"
import { describe, expect, it } from "vitest"
import type { SchemaView } from "./dev-stack-schema-parser"
import { reconcilePgViews } from "./dev-stack-schema-views"

const VIEWS: SchemaView[] = [
  { name: "access_grants", createSql: "CREATE OR REPLACE VIEW access_grants AS SELECT 1 AS one;" },
  {
    name: "assignment_member_cells",
    createSql: "CREATE OR REPLACE VIEW assignment_member_cells AS SELECT 2 AS two;",
  },
]

/** A client whose catalog lists `liveViews` and whose REPLACE fails for `failOn`. */
function fakeClient(liveViews: string[], failOn: string[] = []) {
  const queries: string[] = []
  const runs: Array<{ sql: string; what: string }> = []
  const query = async (sql: string) => {
    queries.push(sql)
    if (sql.includes("information_schema.views")) {
      return { rows: liveViews.map((table_name) => ({ table_name })) }
    }
    if (failOn.some((name) => sql.startsWith(`CREATE OR REPLACE VIEW ${name} `))) {
      throw new Error(`cannot drop columns from view ${failOn[0]}`)
    }
    return { rows: [] }
  }
  const client = { query } as unknown as Pick<Client, "query">
  const run = async (sql: string, what: string) => {
    runs.push({ sql, what })
    await query(sql)
  }
  return { client, run, queries, runs }
}

describe("local dev view reconcile", () => {
  it("creates the views schema.sql defines that the container lacks, in file order", async () => {
    const { client, run, queries, runs } = fakeClient(["access_grants"])

    await expect(reconcilePgViews(client, run, VIEWS)).resolves.toEqual([
      "created view assignment_member_cells",
    ])
    expect(queries.slice(1)).toEqual(VIEWS.map((view) => view.createSql))
    expect(runs).toEqual([])
  })

  it("re-runs every view on a healthy container without reporting a patch", async () => {
    const { client, run, queries } = fakeClient(["access_grants", "assignment_member_cells"])

    await expect(reconcilePgViews(client, run, VIEWS)).resolves.toEqual([])
    // The body is re-asserted so a view whose SELECT changed is brought current.
    expect(queries.slice(1)).toEqual(VIEWS.map((view) => view.createSql))
  })

  it("drops and re-creates a view that CREATE OR REPLACE cannot reshape", async () => {
    const { client, run, runs } = fakeClient(
      ["access_grants", "assignment_member_cells"],
      ["assignment_member_cells"],
    )

    await expect(reconcilePgViews(client, run, VIEWS)).resolves.toEqual([
      "rebuilt view assignment_member_cells",
    ])
    expect(runs).toEqual([
      {
        sql: `DROP VIEW IF EXISTS assignment_member_cells CASCADE;\n${VIEWS[1].createSql}`,
        what: "rebuilding view assignment_member_cells (its column list changed shape)",
      },
    ])
  })

  it("surfaces a view that cannot be built even from scratch", async () => {
    const { client } = fakeClient([], ["access_grants"])
    const failingRun = async (sql: string, what: string) => {
      throw new Error(`[dev-stack] schema reconcile failed while ${what}:\n${sql}`)
    }

    await expect(reconcilePgViews(client, failingRun, VIEWS)).rejects.toThrow(
      "rebuilding view access_grants",
    )
  })
})
