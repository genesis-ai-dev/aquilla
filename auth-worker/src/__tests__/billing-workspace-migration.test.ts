import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { expect, it } from 'vitest'

it('adds workspace billing to existing organizations without classifying or repricing them', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE TABLE organizations (id bigint PRIMARY KEY,
      owner_user_id bigint NOT NULL, name text);
      INSERT INTO organizations VALUES (1, 7, 'Existing partner');`)
    const migration = readFileSync(new URL('../../../db/postgres/migrations/0092_workspace_billing.sql', import.meta.url), 'utf8')
    await db.exec(migration)
    await db.exec(migration)
    expect((await db.query('SELECT name, billing_scope FROM organizations')).rows)
      .toEqual([{ name: 'Existing partner', billing_scope: null }])
    expect((await db.query('SELECT * FROM workspace_plan_entitlements')).rows).toEqual([])
    await db.exec("INSERT INTO organizations VALUES (2, 7, 'Personal', 'personal')")
    await expect(db.exec("INSERT INTO organizations VALUES (3, 7, 'Duplicate', 'personal')"))
      .rejects.toThrow()
  } finally { await db.close() }
})
