// Carrying a termbase off the project_settings blob. (AQU-1006 follow-up)
//
// The cutover is clean — nothing reads `project_settings.terminology` any more
// — so this migration is the ONLY thing standing between an existing project
// and an apparently-empty termbase. Two properties carry that weight and are
// what this file pins:
//
//   1. IDEMPOTENCE BY KEY DERIVATION, not by locking. Both writes are keyed on
//      ids derived from the data (the concept's own uuid; a deterministic hash
//      for the event row), so concurrent runs converge instead of duplicating.
//      If `migrationEventId` ever stops being deterministic, a re-run
//      duplicates the entire migration event log — hence the explicit test.
//   2. NO `?` JSONB OPERATOR in any statement. The Postgres shim rewrites
//      placeholders with a blanket `replace(/\?/g, …)`, so a jsonb `?`
//      key-exists operator is silently eaten as a bind parameter and the
//      statement fails at runtime with an argument-count mismatch. This is a
//      trap you cannot see in review, so it is asserted mechanically.

import { describe, it, expect } from 'vitest'
import { migrationEventId } from '../events/migrate-concepts'

describe('migrationEventId', () => {
  it('is deterministic — a re-run reuses the same event id and no-ops', () => {
    // The whole idempotence story rests on this. A random id here would make
    // every concurrent reader append a duplicate copy of the migration.
    const a = migrationEventId('proj-1', 'cpt-1')
    const b = migrationEventId('proj-1', 'cpt-1')
    expect(a).toBe(b)
  })

  it('separates concepts and projects', () => {
    const base = migrationEventId('proj-1', 'cpt-1')
    expect(migrationEventId('proj-1', 'cpt-2')).not.toBe(base)
    expect(migrationEventId('proj-2', 'cpt-1')).not.toBe(base)
  })

  it('is uuid-shaped, so it reads correctly in the events table', () => {
    expect(migrationEventId('proj-1', 'cpt-1')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('does not collide across a spread of realistic ids', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 2000; i++) ids.add(migrationEventId('proj-1', `concept-${i}`))
    expect(ids.size).toBe(2000)
  })
})

describe('shim placeholder safety', () => {
  it('uses no jsonb `?` operator, which the shim would eat as a bind parameter', async () => {
    // db/shim/postgres.ts: `query.replace(/\?/g, () => '$' + ++i)` is
    // unconditional. Any jsonb `?`, `?|` or `?&` in a statement becomes a
    // placeholder and the query fails at runtime — never in typecheck, never
    // in review. Assert on the source so the trap cannot be reintroduced.
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    // Resolve from this test file's directory rather than a URL — the worker
    // tsconfig's DOM URL type is not node:url's, and the mismatch is noise.
    const source = readFileSync(
      path.join(__dirname, '..', 'events', 'migrate-concepts.ts'),
      'utf8',
    )
    // Extract ONLY `.prepare(`…`)` arguments. An earlier version of this test
    // matched any backtick run containing a SQL keyword and tripped over prose
    // in the doc comments, which mention SELECT.
    const sql = [...source.matchAll(/\.prepare\(\s*`([\s\S]*?)`/g)].map((m) => m[1])
    expect(sql.length).toBeGreaterThan(0)
    for (const statement of sql) {
      // Every `?` in a statement must be a standalone bind placeholder:
      // never `?` glued to a quoted key, and never `?|` / `?&`.
      expect(statement).not.toMatch(/\?\s*'/)
      expect(statement).not.toMatch(/\?[|&]/)
    }
  })
})
