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

it('preserves checkout attempts on migration replay and rejects a second attempt or live mode', async () => {
  const db = new PGlite()
  try {
    await db.exec('CREATE TABLE organizations (id bigint PRIMARY KEY); INSERT INTO organizations VALUES (1)')
    const migration = readFileSync(new URL('../../../db/postgres/migrations/0093_workspace_checkout_attempts.sql', import.meta.url), 'utf8')
    await db.exec(migration)
    await db.exec(`INSERT INTO workspace_checkout_attempts
      (id, org_id, account_id, fingerprint, catalog_json, prices_json, quote_json, request_params, expires_at)
      VALUES ('first', 1, 'acct_test', 'same', '{}', '[]', '{}', '{}', 123)`)
    await db.exec(migration)
    expect((await db.query('SELECT id, sandbox FROM workspace_checkout_attempts')).rows)
      .toEqual([{ id: 'first', sandbox: true }])
    await expect(db.exec(`INSERT INTO workspace_checkout_attempts
      SELECT 'second', org_id, account_id, fingerprint, catalog_json, prices_json,
      quote_json, request_params, expires_at, created_at, session_id, sandbox
      FROM workspace_checkout_attempts`)).rejects.toThrow()
    await expect(db.exec('UPDATE workspace_checkout_attempts SET sandbox = FALSE')).rejects.toThrow()
  } finally { await db.close() }
})
