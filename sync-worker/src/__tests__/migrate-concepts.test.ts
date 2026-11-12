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

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { migrationEventId, migrateProjectConcepts, readBlobConcepts } from '../events/migrate-concepts'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

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

// Shapes that were written into project_settings.terminology before the
// cutover, and that loadBlobConcepts drops today:
//
//   sourceTerm: "" or whitespace — GlossaryRow's InlineCell commits the
//   draft on blur with no trim (445b78655^ GlossaryRow.tsx), and
//   GlossaryEditor.onEditSource persists it through updateConcept.
//
//   id: "" — importConceptsTbx keeps an empty termEntry id attribute
//   (`idMatch ? idMatch[1] : uuid()`, regex \bid="([^"]*)") instead of
//   minting a uuid. Present since 192c021a4.
//
// scripts/migrate-concepts.ts selects every non-empty terminology array, so
// both a mixed array and an array of only these entries reach
// migrateProjectConcepts. The filter then treats them as absent and
// clearTerminologyKey deletes the whole key.

const PROJECT = 'proj-keep'

/** Written by addConcept / the terminology page: id + sourceTerm, both set. */
const GRACE = {
  id: 'cpt-grace',
  sourceTerm: 'grace',
  renderings: [{ rendering: 'gracia', status: 'preferred' as const }],
  notes: 'kindness',
  status: 'active' as const,
  createdAt: '2026-08-01T12:00:00.000Z',
  createdBy: 'luke',
  caseSensitive: true,
}

const MERCY = {
  id: 'cpt-mercy',
  sourceTerm: 'mercy',
  renderings: [{ rendering: 'misericordia', status: 'admitted' as const }],
  status: 'draft' as const,
  createdAt: '2026-08-02T12:00:00.000Z',
  createdBy: 'ada',
}

/** Inline-edit commit of a cleared headword. The id, renderings, and notes stay. */
const CLEARED_HEADWORD = {
  id: 'cpt-blank',
  sourceTerm: '',
  renderings: [{ rendering: 'still-here', status: 'admitted' as const }],
  notes: 'user cleared the headword',
  status: 'active' as const,
  createdAt: '2026-08-03T12:00:00.000Z',
  updatedAt: '2026-08-03T12:05:00.000Z',
}

/** Same commit path when the draft is only spaces. The filter trims it away. */
const WHITESPACE_HEADWORD = {
  id: 'cpt-space',
  sourceTerm: '   ',
  renderings: [{ rendering: 'espacio', status: 'preferred' as const }],
  status: 'draft' as const,
  createdAt: '2026-08-04T12:00:00.000Z',
}

/** TBX `<termEntry id="">` persists an empty id with a real source term. */
const EMPTY_TBX_ID = {
  id: '',
  sourceTerm: 'covenant',
  renderings: [{ rendering: 'pacto', status: 'preferred' as const }],
  notes: 'from tbx',
  status: 'active' as const,
  createdAt: '2026-08-05T12:00:00.000Z',
}

const UNMIGRATABLE = [CLEARED_HEADWORD, WHITESPACE_HEADWORD, EMPTY_TBX_ID]

describe('migrateProjectConcepts blob retention', () => {
  let tdb: TestDb
  const sqlLog: string[] = []

  beforeAll(async () => {
    tdb = await makeTestDb({}, {
      onStatement(sql) {
        sqlLog.push(sql.replace(/\s+/g, ' ').trim())
      },
    })
  })

  afterAll(async () => {
    await tdb.close()
  })

  beforeEach(async () => {
    sqlLog.length = 0
    await tdb.reset()
  })

  async function insertSettings(settings: unknown): Promise<void> {
    const text = typeof settings === 'string' ? settings : JSON.stringify(settings)
    await tdb.pg.query(
      'INSERT INTO project_settings (project_id, settings) VALUES ($1, $2)',
      [PROJECT, text],
    )
  }

  async function storedSettings(): Promise<unknown> {
    const rows = await tdb.rows<{ settings: string }>('project_settings')
    expect(rows).toHaveLength(1)
    return JSON.parse(rows[0].settings)
  }

  async function conceptRows(): Promise<Array<Record<string, unknown>>> {
    return tdb.rows('concepts')
  }

  async function eventRows(): Promise<Array<{ id: string; kind: string; author: string; payload: string }>> {
    return tdb.rows('events')
  }

  function eventInserts(): string[] {
    return sqlLog.filter((sql) => sql.includes('INSERT INTO events'))
  }

  function clearStatements(): string[] {
    return sqlLog.filter((sql) => sql.includes("- 'terminology'"))
  }

  it('migrates a blob of well-formed concepts with zero loss, and clears the key only after they are written', async () => {
    await insertSettings({
      sourceLanguage: 'grc',
      terminology: [GRACE, MERCY],
    })

    const result = await migrateProjectConcepts(tdb.db, PROJECT)

    expect(result).toMatchObject({ migrated: true, count: 2, skipped: 0 })

    const conceptInsertAt = sqlLog.findIndex((sql) => sql.includes('INSERT INTO concepts'))
    const clearAt = sqlLog.findIndex((sql) => sql.includes("- 'terminology'"))
    expect(conceptInsertAt).toBeGreaterThan(-1)
    expect(clearAt).toBeGreaterThan(conceptInsertAt)

    const concepts = await conceptRows()
    expect(concepts.map((row) => row.source_term).sort()).toEqual(['grace', 'mercy'])
    const grace = concepts.find((row) => row.concept_id === 'cpt-grace')
    expect(grace).toMatchObject({
      source_term: 'grace',
      notes: 'kindness',
      status: 'active',
      case_sensitive: 1,
      created_by: 'luke',
    })
    expect(Number(grace?.created_at)).toBe(Date.parse(GRACE.createdAt))

    const events = await eventRows()
    expect(events).toHaveLength(2)
    for (const event of events) {
      const payload = JSON.parse(event.payload) as { conceptId: string; sourceTerm: string; caseSensitive?: boolean; notes?: string }
      expect(event.kind).toBe('term.create')
      expect(event.id).toBe(migrationEventId(PROJECT, payload.conceptId))
    }
    const graceEvent = events.find((event) => event.author === 'luke')
    expect(JSON.parse(graceEvent!.payload)).toMatchObject({
      conceptId: 'cpt-grace',
      sourceTerm: 'grace',
      renderings: [{ rendering: 'gracia', status: 'preferred' }],
      notes: 'kindness',
      status: 'active',
      caseSensitive: true,
    })

    const settings = await storedSettings() as { sourceLanguage?: string; terminology?: unknown }
    expect(settings.sourceLanguage).toBe('grc')
    expect(settings.terminology).toBeUndefined()
    expect(clearStatements()).toHaveLength(1)
  })

  it('migrates the well-formed entries, leaves the unmappable ones in the blob, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await insertSettings({
      sourceLanguage: 'grc',
      terminology: [GRACE, CLEARED_HEADWORD, MERCY, EMPTY_TBX_ID, WHITESPACE_HEADWORD],
    })

    try {
      const result = await migrateProjectConcepts(tdb.db, PROJECT)

      const settings = await storedSettings() as { sourceLanguage?: string; terminology?: unknown }
      expect(settings.sourceLanguage).toBe('grc')
      expect(settings.terminology).toEqual([CLEARED_HEADWORD, EMPTY_TBX_ID, WHITESPACE_HEADWORD])
      expect(result).toMatchObject({ migrated: true, count: 2, skipped: 3 })
      const concepts = await conceptRows()
      expect(concepts.map((row) => row.source_term).sort()).toEqual(['grace', 'mercy'])
      expect(clearStatements()).toHaveLength(0)

      const messages = warn.mock.calls.map((call) => call.map(String).join(' '))
      expect(messages.some((message) => message.includes(PROJECT) && message.includes('3'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not clear a blob whose every entry is unusable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await insertSettings({
      sourceLanguage: 'grc',
      terminology: UNMIGRATABLE,
    })

    try {
      const result = await migrateProjectConcepts(tdb.db, PROJECT)

      const settings = await storedSettings() as { sourceLanguage?: string; terminology?: unknown }
      expect(settings).toEqual({ sourceLanguage: 'grc', terminology: UNMIGRATABLE })
      expect(result).toMatchObject({ migrated: false, count: 0, skipped: 3 })
      expect(await conceptRows()).toHaveLength(0)
      expect(await eventRows()).toHaveLength(0)
      expect(clearStatements()).toHaveLength(0)

      const messages = warn.mock.calls.map((call) => call.map(String).join(' '))
      expect(messages.some((message) => message.includes(PROJECT) && message.includes('3'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not insert a second event per concept when a fully migrated project is run again', async () => {
    await insertSettings({
      sourceLanguage: 'grc',
      terminology: [GRACE, MERCY],
    })

    await migrateProjectConcepts(tdb.db, PROJECT)
    const afterFirst = eventInserts().length
    expect(afterFirst).toBe(2)
    expect(await eventRows()).toHaveLength(2)

    sqlLog.length = 0
    const again = await migrateProjectConcepts(tdb.db, PROJECT)
    expect(again).toMatchObject({ migrated: false, count: 0, skipped: 0 })
    expect(eventInserts()).toHaveLength(0)
    expect(await eventRows()).toHaveLength(2)
    const ids = (await eventRows()).map((event) => event.id).sort()
    expect(ids).toEqual([
      migrationEventId(PROJECT, GRACE.id),
      migrationEventId(PROJECT, MERCY.id),
    ].sort())
  })

  it('clears an empty terminology array and leaves an absent key alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await insertSettings({ sourceLanguage: 'grc', terminology: [] })
      const emptied = await migrateProjectConcepts(tdb.db, PROJECT)
      expect(emptied).toMatchObject({ migrated: false, count: 0, skipped: 0 })
      expect(await storedSettings()).toEqual({ sourceLanguage: 'grc' })

      await tdb.reset()
      sqlLog.length = 0
      await insertSettings({ sourceLanguage: 'grc' })
      const absent = await migrateProjectConcepts(tdb.db, PROJECT)
      expect(absent).toMatchObject({ migrated: false, count: 0, skipped: 0 })
      expect(await storedSettings()).toEqual({ sourceLanguage: 'grc' })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('does not delete a terminology value that is not an array of concepts', async () => {
    // Agent playbook 9df5263e7 (2026-08-19) through eeeec8e71 (2026-09-10)
    // told PatchSettings to write this object. AQU-1224 corrected the docs;
    // the value is not an array, and deleting it would drop whatever it holds.
    const wrapped = {
      concepts: [{ id: 'cpt-faith', sourceTerm: 'faith', renderings: [], status: 'active', createdAt: '2026-08-19T00:00:00.000Z' }],
    }
    await insertSettings({ sourceLanguage: 'en', terminology: wrapped })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await migrateProjectConcepts(tdb.db, PROJECT)
      expect(await storedSettings()).toEqual({ sourceLanguage: 'en', terminology: wrapped })
      expect(result).toMatchObject({ migrated: false, count: 0, skipped: 0 })
      expect(await conceptRows()).toHaveLength(0)
      expect(clearStatements()).toHaveLength(0)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('refuses to clear an unparseable settings blob', async () => {
    const calls: string[] = []
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind() { return stmt },
          async first() {
            if (sql.includes('SELECT settings')) return { settings: '{not-json' }
            return null
          },
          async run() {
            calls.push(sql)
            return { results: [], success: true as const, meta: {} }
          },
          async all() {
            return { results: [], success: true as const, meta: {} }
          },
          async raw() { return [] },
        }
        return stmt
      },
      async batch() {
        calls.push('batch')
        return []
      },
      async exec() { return { count: 0, duration: 0 } },
      async close() {},
    } as unknown as AquillaDb

    const result = await migrateProjectConcepts(db, PROJECT)
    expect(result).toMatchObject({ migrated: false, count: 0, skipped: 0 })
    expect(calls.some((sql) => sql.includes('terminology'))).toBe(false)
    expect(calls).not.toContain('batch')
  })

  it('readBlobConcepts still only decodes mappable entries and does not write', async () => {
    await insertSettings({
      sourceLanguage: 'grc',
      terminology: [GRACE, CLEARED_HEADWORD, EMPTY_TBX_ID],
    })
    const before = sqlLog.length
    const legacy = await readBlobConcepts(tdb.db, PROJECT)
    expect(legacy.map((row) => row.conceptId)).toEqual(['cpt-grace'])
    expect(legacy[0].sourceTerm).toBe('grace')
    expect(sqlLog.slice(before).some((sql) => sql.startsWith('UPDATE') || sql.startsWith('INSERT'))).toBe(false)
    const settings = await storedSettings() as { terminology?: unknown }
    expect(settings.terminology).toEqual([GRACE, CLEARED_HEADWORD, EMPTY_TBX_ID])
  })
})

describe('migrate-concepts script warning', () => {
  it('prints the skip warning from the function result', () => {
    const script = readFileSync(
      path.join(__dirname, '..', '..', '..', 'scripts', 'migrate-concepts.ts'),
      'utf8',
    )
    expect(script).toContain('result.skipped')
    expect(script).toMatch(/console\.warn\([\s\S]*result\.skipped/)
    expect(script).not.toMatch(/JSON\.parse\([\s\S]*terminology/)
  })
})
