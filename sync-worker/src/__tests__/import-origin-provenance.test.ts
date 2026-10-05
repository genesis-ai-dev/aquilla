// AQU-1673 — "Import existing translations as staged proposals".
//
// An uploaded translation set can be staged as proposals instead of committed,
// and each proposal records WHICH file it came from so a reviewer can tell an
// imported human translation from an AI draft. These tests pin the two halves
// of that contract on the command surface:
//
//   1. `importOrigin` is PARSED, never passed through — a caller cannot use
//      provenance as a hole to smuggle extra keys into the compiled event
//      payload, and a malformed shape is a named validation issue rather than
//      silently-unlabelled proposals.
//   2. It never implies AI authorship. `ai_suggestion`/`ai_draft` are
//      server-minted for the DraftCells path; import provenance is descriptive
//      and must not set them, or imported text would read back as a pending AI
//      draft and be reviewed as machine output.

import { describe, it, expect } from 'vitest'
import { validateCommands, parseImportOrigin, type SetTranslationCommand } from '../external/commands'
import { IMPORTED_ORIGIN_FILENAME_MAX } from '../events/types'

const BASE = { kind: 'SetTranslation', fileId: 'f1', cellId: 'c1', value: 'hola' }

function validateOne(cmd: Record<string, unknown>) {
  const res = validateCommands([cmd])
  return res
}

function setTranslation(cmd: Record<string, unknown>): SetTranslationCommand {
  const res = validateOne(cmd)
  if (!res.ok) throw new Error(`expected valid, got ${JSON.stringify(res.issues)}`)
  const c = res.commands[0]
  if (c.kind !== 'SetTranslation') throw new Error(`expected SetTranslation, got ${c.kind}`)
  return c
}

describe('parseImportOrigin', () => {
  it('accepts a well-formed origin and trims the file name', () => {
    expect(parseImportOrigin({ fileName: '  revised-tr.csv  ', importedAt: 1_700_000_000_000 })).toEqual({
      fileName: 'revised-tr.csv',
      importedAt: 1_700_000_000_000,
    })
  })

  it.each([
    ['not an object', 'revised.csv'],
    ['null', null],
    ['missing fileName', { importedAt: 1 }],
    ['blank fileName', { fileName: '   ', importedAt: 1 }],
    ['non-string fileName', { fileName: 42, importedAt: 1 }],
    ['missing importedAt', { fileName: 'a.csv' }],
    ['non-numeric importedAt', { fileName: 'a.csv', importedAt: '1' }],
    ['non-finite importedAt', { fileName: 'a.csv', importedAt: Number.POSITIVE_INFINITY }],
    ['NaN importedAt', { fileName: 'a.csv', importedAt: Number.NaN }],
  ])('rejects %s', (_label, raw) => {
    expect(parseImportOrigin(raw)).toBeNull()
  })

  it('rejects a file name past the length ceiling so provenance cannot carry a payload', () => {
    const justOk = 'x'.repeat(IMPORTED_ORIGIN_FILENAME_MAX)
    const tooLong = 'x'.repeat(IMPORTED_ORIGIN_FILENAME_MAX + 1)
    expect(parseImportOrigin({ fileName: justOk, importedAt: 1 })).not.toBeNull()
    expect(parseImportOrigin({ fileName: tooLong, importedAt: 1 })).toBeNull()
  })
})

describe('validateCommands — SetTranslation.importOrigin (AQU-1673)', () => {
  it('keeps import provenance on the rebuilt command', () => {
    const cmd = setTranslation({
      ...BASE,
      importOrigin: { fileName: 'samuel-revisions.csv', importedAt: 1_700_000_000_000 },
    })
    expect(cmd.importOrigin).toEqual({
      fileName: 'samuel-revisions.csv',
      importedAt: 1_700_000_000_000,
    })
  })

  it('omits it entirely when the caller sends none (direct imports and agent text)', () => {
    expect(setTranslation({ ...BASE })).not.toHaveProperty('importOrigin')
  })

  it('rejects a malformed origin with a named issue instead of staging it unlabelled', () => {
    const res = validateOne({ ...BASE, importOrigin: { fileName: '' } })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.issues).toHaveLength(1)
    expect(res.issues[0].message).toContain('SetTranslation.importOrigin')
  })

  it('rebuilds provenance from known keys only — extra keys never reach the payload', () => {
    const cmd = setTranslation({
      ...BASE,
      importOrigin: {
        fileName: 'a.csv',
        importedAt: 1,
        // A caller cannot ride along on provenance: not an authorship claim it
        // could forge, not a field the compiled event will carry.
        ai_suggestion: true,
        injected: 'nope',
      },
    })
    expect(Object.keys(cmd.importOrigin ?? {}).sort()).toEqual(['fileName', 'importedAt'])
  })

  it('does not let a caller self-assert AI authorship alongside it', () => {
    // aiDraft stays server-minted (AQU-1186): validateCommands rebuilds from
    // known keys, so a caller-supplied one is dropped even when it arrives
    // next to legitimate import provenance.
    const cmd = setTranslation({
      ...BASE,
      aiDraft: { model: 'forged', provider: 'forged', promptVersion: '1', exampleIds: [], generatedAt: 0, mode: 'batch', projectState: {} },
      importOrigin: { fileName: 'a.csv', importedAt: 1 },
    })
    expect(cmd.aiDraft).toBeUndefined()
    expect(cmd.importOrigin).toBeDefined()
  })

  it('carries provenance through alongside an explicit lane', () => {
    const cmd = setTranslation({
      ...BASE,
      laneId: 'es',
      importOrigin: { fileName: 'a.csv', importedAt: 1 },
    })
    expect(cmd.laneId).toBe('es')
    expect(cmd.importOrigin?.fileName).toBe('a.csv')
  })
})
