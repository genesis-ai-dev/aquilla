// AQU-1529: an existing OAuth deployment upgrades without losing legacy grants.
import { readFileSync } from "node:fs"
import { URL } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { expect, it } from "vitest"

it("upgrades legacy OAuth scope and enforces organization grant shape", async () => {
  const pg = new PGlite()
  try {
    await pg.exec(`CREATE TABLE api_credentials (
      id text PRIMARY KEY, org_id text, project_id text
    ); INSERT INTO api_credentials VALUES ('legacy', NULL, 'project');`)
    await pg.exec(readFileSync(new URL("../../../db/postgres/migrations/0124_mcp_oauth_codes.sql", import.meta.url), "utf8"))
    await pg.exec(`INSERT INTO mcp_oauth_codes
      (code_hash, client_id, client_name, redirect_uri, code_challenge,
       user_id, mode, project_id, expires_at)
      VALUES ('legacy', 'client', 'Client', 'https://host/cb', 'pkce',
        '1', 'ask', 'project', now() + interval '5 minutes')`)
    await pg.exec(readFileSync(new URL("../../../db/postgres/migrations/0125_mcp_oauth_org_scope.sql", import.meta.url), "utf8"))
    expect((await pg.query("SELECT project_id, org_ids FROM mcp_oauth_codes WHERE code_hash = 'legacy'")).rows)
      .toEqual([{ project_id: "project", org_ids: null }])
    await pg.exec(`INSERT INTO mcp_oauth_codes
      (code_hash, client_id, client_name, redirect_uri, code_challenge,
       user_id, mode, org_ids, expires_at)
      VALUES ('new', 'client', 'Client', 'https://host/cb', 'pkce',
        '1', 'act', '["10", "11"]', now() + interval '5 minutes')`)
    await expect(pg.exec("UPDATE mcp_oauth_codes SET org_ids = '[]' WHERE code_hash = 'new'"))
      .rejects.toThrow(/check constraint/)
    await expect(pg.exec("UPDATE api_credentials SET org_ids = '[\"10\"]' WHERE id = 'legacy'"))
      .rejects.toThrow(/check constraint/)
    await pg.exec("UPDATE api_credentials SET project_id = NULL, org_ids = '[\"10\"]' WHERE id = 'legacy'")
  } finally { await pg.close() }
})
