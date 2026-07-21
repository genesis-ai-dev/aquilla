import { describe, expect, it } from 'vitest'
import {
  compilePlanImport,
  validatePlanImportManifest,
  type PlanImportInput,
} from '../external/import-manifest'

describe('normalized PlanImport compiler', () => {
  it('upgrades legacy flat cells to the same Scripture/sequence metadata envelope', () => {
    const compiled = compilePlanImport({
      fileType: 'usfm',
      cells: [
        { content: 'A title', type: 'heading' },
        { content: 'In the beginning', type: 'verse', canonicalRef: 'GEN 1:1' },
      ],
    })

    expect(compiled.fileSummary).toMatchObject({
      version: 1,
      profileId: 'agent:usfm',
      deterministic: true,
      fidelity: 'native',
      unitCount: 2,
    })
    expect(compiled.units[0].metadata.aquillaImport).toMatchObject({
      kind: 'heading',
      displayLabel: null,
      unitKey: 'sequence:1',
    })
    expect(compiled.units[1].metadata.aquillaImport).toMatchObject({
      kind: 'verse',
      displayLabel: '1',
      unitKey: 'scripture:GEN 1:1',
      address: { scheme: 'scripture', book: 'GEN', chapter: 1, verse: '1' },
    })
  })

  it('preserves explicit recipe locators and does not execute recipe config', () => {
    const marker = { called: false }
    const input: PlanImportInput = {
      fileType: 'custom',
      manifest: {
        version: 1,
        profileId: 'agent:custom-lines',
        profileVersion: '1',
        deterministic: false,
        fidelity: 'content-only',
        recipe: {
          version: 1,
          name: 'Custom lines',
          inputFormat: 'custom',
          strategy: 'model-assisted',
          config: { marker },
        },
      },
      cells: [{
        content: 'Hello',
        unitKey: 'custom:line:7',
        displayLabel: '7',
        address: { scheme: 'custom', line: 7 },
        sourceLocator: { kind: 'line', line: 7 },
      }],
    }

    expect(validatePlanImportManifest(input)).toEqual([])
    const compiled = compilePlanImport(input)
    expect(marker.called).toBe(false)
    expect(compiled.units[0].metadata.aquillaImport).toMatchObject({
      unitKey: 'custom:line:7',
      displayLabel: '7',
      address: { scheme: 'custom', line: 7 },
      sourceLocator: { kind: 'line', line: 7 },
    })
    expect(compiled.fileSummary.recipe).toEqual(input.manifest?.recipe)
  })

  it('rejects structural labels, duplicate explicit keys, invalid timing, and unverified fidelity claims', () => {
    const issues = validatePlanImportManifest({
      fileType: 'custom',
      manifest: {
        version: 1,
        profileId: 'agent:bad',
        profileVersion: '1',
        deterministic: false,
        fidelity: 'verified-recipe',
        recipe: {
          version: 1,
          name: 'Bad',
          inputFormat: 'custom',
          strategy: 'regex',
          config: {},
          roundTripVerified: false,
        },
      },
      cells: [
        { content: 'Heading', type: 'heading', displayLabel: '1', unitKey: 'same' },
        { content: 'Cue', type: 'cue', unitKey: 'same', startMs: 2000, endMs: 1000 },
      ],
    })

    expect(issues).toEqual(expect.arrayContaining([
      'verified-recipe fidelity requires recipe.roundTripVerified=true',
      'cells[0].displayLabel must be null for structural content',
      'cells[1].unitKey duplicates same',
      'cells[1].endMs must be after startMs',
    ]))
  })

  it('allows the same unit to carry independent target variants but rejects duplicate lanes', () => {
    const valid: PlanImportInput = {
      fileType: 'xliff',
      cells: [{
        content: 'Hello',
        variants: [
          { laneId: 'fr-formal', content: 'Bonjour' },
          { laneId: 'fr-simple', content: 'Salut' },
        ],
      }],
    }
    expect(validatePlanImportManifest(valid)).toEqual([])

    valid.cells[0].variants!.push({ laneId: 'fr-formal', content: 'Rebonjour' })
    expect(validatePlanImportManifest(valid)).toContain('cells[0].variants[2].laneId is duplicated')
  })
})
