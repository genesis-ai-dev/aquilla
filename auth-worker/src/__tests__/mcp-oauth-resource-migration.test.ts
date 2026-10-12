// AQU-1584: upgrade OAuth audiences without expiring device/PAT connections.
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'

it('binds identifiable OAuth grants and revokes unknown OAuth grants only', async () => {
  const pg = new PGlite()
  try {
    await pg.exec(`CREATE TABLE api_credentials (
      id uuid PRIMARY KEY, org_ids jsonb, revoked_at timestamptz
    ); CREATE TABLE mcp_oauth_codes (
      credential_id uuid, resource text, status text
    ); INSERT INTO api_credentials VALUES
      ('00000000-0000-0000-0000-000000000001', NULL, NULL),
      ('00000000-0000-0000-0000-000000000002', '["10"]', NULL),
      ('00000000-0000-0000-0000-000000000003', '["10"]', NULL);
    INSERT INTO mcp_oauth_codes VALUES
      ('00000000-0000-0000-0000-000000000002', 'https://api.aquilla.app/sync/api/v1/external/mcp', 'consumed');`)
    const migration = readFileSync(new URL('../../../db/postgres/migrations/0130_mcp_oauth_resource.sql', import.meta.url), 'utf8')
    await pg.exec(migration)
    const rows = (await pg.query<{ oauth_resource: string | null; revoked: boolean }>(
      'SELECT oauth_resource, revoked_at IS NOT NULL AS revoked FROM api_credentials ORDER BY id',
    )).rows
    expect(rows).toEqual([
      { oauth_resource: null, revoked: false },
      { oauth_resource: 'https://api.aquilla.app/sync/api/v1/external/mcp', revoked: false },
      { oauth_resource: null, revoked: true },
    ])
    await pg.exec(migration)
    expect((await pg.query('SELECT count(*)::int AS n FROM api_credentials WHERE revoked_at IS NOT NULL')).rows)
      .toEqual([{ n: 1 }])
  } finally { await pg.close() }
})
