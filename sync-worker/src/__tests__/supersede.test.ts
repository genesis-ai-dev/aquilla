// Supersession predicate rules (command registry P1 §3.1). The predicate is
// pure, so these tests state the per-kind rule table directly — including the
// load-bearing bias: anything that cannot be checked cleanly is NOT satisfied,
// and one unsatisfied command sinks the whole plan.

import { describe, it, expect } from 'vitest'

import { isPlanSatisfied, explainPlanSatisfaction, type SupersedeLiveState } from '../external/supersede'
import { cellKey, laneCellKey } from '../external/cell-keys'
import type { Command } from '../external/commands'

const FILE = 'file-x'
const CELL = 'cell-1'

function live(overrides: Partial<SupersedeLiveState> = {}): SupersedeLiveState {
  return {
    targetValues: new Map(),
    waivedRules: new Map(),
    validators: new Map(),
    commentResolved: new Map(),
    actorUsername: 'alice',
    ...overrides,
  }
}

function targets(entries: [string, { value: string; valueHtml: string | null }][]) {
  return new Map(entries)
}

describe('isPlanSatisfied — SetTranslation', () => {
  const plan: Command[] = [{ kind: 'SetTranslation', fileId: FILE, cellId: CELL, value: 'hola' }]

  it('is satisfied when the live target value already equals the planned value', () => {
    const state = live({
      targetValues: targets([[laneCellKey(FILE, CELL), { value: 'hola', valueHtml: null }]]),
    })
    expect(isPlanSatisfied(plan, state)).toBe(true)
  })

  it('is not satisfied when the live value differs', () => {
    const state = live({
      targetValues: targets([[laneCellKey(FILE, CELL), { value: 'otra cosa', valueHtml: null }]]),
    })
    expect(isPlanSatisfied(plan, state)).toBe(false)
  })

  it('is not satisfied when no target row exists at all', () => {
    expect(isPlanSatisfied(plan, live())).toBe(false)
  })

  it('is lane-scoped — a matching value in another lane does not satisfy the plan', () => {
    const esPlan: Command[] = [{ ...plan[0], laneId: 'es' } as Command]
    const state = live({
      targetValues: targets([[laneCellKey(FILE, CELL), { value: 'hola', valueHtml: null }]]),
    })
    expect(isPlanSatisfied(esPlan, state)).toBe(false)
    const esState = live({
      targetValues: targets([[laneCellKey(FILE, CELL, 'es'), { value: 'hola', valueHtml: null }]]),
    })
    expect(isPlanSatisfied(esPlan, esState)).toBe(true)
  })

  it('requires the HTML to match too when the plan carries HTML', () => {
    const htmlPlan: Command[] = [
      { kind: 'SetTranslation', fileId: FILE, cellId: CELL, value: 'hola', valueHtml: '<p>hola</p>' },
    ]
    const wrongHtml = live({
      targetValues: targets([[laneCellKey(FILE, CELL), { value: 'hola', valueHtml: '<b>hola</b>' }]]),
    })
    expect(isPlanSatisfied(htmlPlan, wrongHtml)).toBe(false)
    const rightHtml = live({
      targetValues: targets([[laneCellKey(FILE, CELL), { value: 'hola', valueHtml: '<p>hola</p>' }]]),
    })
    expect(isPlanSatisfied(htmlPlan, rightHtml)).toBe(true)
  })
})

describe('isPlanSatisfied — PatchSettings', () => {
  const plan: Command[] = [
    {
      kind: 'PatchSettings',
      projectId: 'p1',
      ops: [{ key: 'targetLanes', value: ['es', 'pt'] }],
      ifMatchVersion: 3,
    },
  ]

  it('is satisfied when every op key already deep-equals the proposed value', () => {
    expect(isPlanSatisfied(plan, live({ settings: { targetLanes: ['es', 'pt'] } }))).toBe(true)
  })

  it('is not satisfied when a value differs (array order counts)', () => {
    expect(isPlanSatisfied(plan, live({ settings: { targetLanes: ['pt', 'es'] } }))).toBe(false)
    expect(isPlanSatisfied(plan, live({ settings: {} }))).toBe(false)
  })

  it('is not satisfied when only some of several ops already hold', () => {
    const multi: Command[] = [
      {
        kind: 'PatchSettings',
        projectId: 'p1',
        ops: [
          { key: 'targetLanes', value: ['es'] },
          { key: 'sourceLanguage', value: 'grc' },
        ],
        ifMatchVersion: 3,
      },
    ]
    const state = live({ settings: { targetLanes: ['es'], sourceLanguage: 'hbo' } })
    expect(isPlanSatisfied(multi, state)).toBe(false)
  })

  it('is not satisfied when live settings were never resolved', () => {
    expect(isPlanSatisfied(plan, live())).toBe(false)
  })
})

describe('isPlanSatisfied — EmitEvents', () => {
  it('cell.waive is satisfied only when THAT rule is already waived on the cell', () => {
    const plan: Command[] = [
      { kind: 'EmitEvents', events: [{ kind: 'cell.waive', fileId: FILE, cellId: CELL, payload: { ruleId: 'r-1' } }] },
    ]
    const waived = live({ waivedRules: new Map([[cellKey(FILE, CELL), new Set(['r-1'])]]) })
    expect(isPlanSatisfied(plan, waived)).toBe(true)
    const otherRule = live({ waivedRules: new Map([[cellKey(FILE, CELL), new Set(['r-2'])]]) })
    expect(isPlanSatisfied(plan, otherRule)).toBe(false)
    expect(isPlanSatisfied(plan, live())).toBe(false)
  })

  it("cell.validate is satisfied only by THIS actor's validation in THIS lane", () => {
    const plan: Command[] = [
      { kind: 'EmitEvents', events: [{ kind: 'cell.validate', fileId: FILE, cellId: CELL, payload: {} }] },
    ]
    const mine = live({ validators: new Map([[laneCellKey(FILE, CELL), new Set(['alice'])]]) })
    expect(isPlanSatisfied(plan, mine)).toBe(true)
    // Validation is per-person testimony: someone else's row is a different
    // fact, not this plan's end-state.
    const theirs = live({ validators: new Map([[laneCellKey(FILE, CELL), new Set(['bob'])]]) })
    expect(isPlanSatisfied(plan, theirs)).toBe(false)
    const otherLane = live({ validators: new Map([[laneCellKey(FILE, CELL, 'es'), new Set(['alice'])]]) })
    expect(isPlanSatisfied(plan, otherLane)).toBe(false)
  })

  it('comment.resolve is satisfied when the thread already holds the planned flag', () => {
    const resolvePlan: Command[] = [
      { kind: 'EmitEvents', events: [{ kind: 'comment.resolve', payload: { commentId: 'c-1', resolved: true } }] },
    ]
    expect(isPlanSatisfied(resolvePlan, live({ commentResolved: new Map([['c-1', true]]) }))).toBe(true)
    expect(isPlanSatisfied(resolvePlan, live({ commentResolved: new Map([['c-1', false]]) }))).toBe(false)
    // Deleted / unknown thread is absent from the map — never a yes.
    expect(isPlanSatisfied(resolvePlan, live())).toBe(false)

    const unresolvePlan: Command[] = [
      { kind: 'EmitEvents', events: [{ kind: 'comment.resolve', payload: { commentId: 'c-1', resolved: false } }] },
    ]
    expect(isPlanSatisfied(unresolvePlan, live({ commentResolved: new Map([['c-1', false]]) }))).toBe(true)
  })

  it.each([
    'cell.unwaive',
    'cell.unvalidate',
    'cell.backtranslation.set',
    'target.cell.repin',
    'comment.create',
    'comment.edit',
    'comment.delete',
    'file.rename',
    'file.delete',
    'file.restore',
    'assignment.create',
    'assignment.reassign',
    'assignment.unassign',
  ])('%s has no clean end-state check, so it is never satisfied', (kind) => {
    const plan: Command[] = [
      { kind: 'EmitEvents', events: [{ kind, fileId: FILE, cellId: CELL, payload: { ruleId: 'r-1' } }] },
    ]
    // Live state is as generous as it can be — the answer is still no.
    const generous = live({
      waivedRules: new Map([[cellKey(FILE, CELL), new Set(['r-1'])]]),
      validators: new Map([[laneCellKey(FILE, CELL), new Set(['alice'])]]),
      commentResolved: new Map([['c-1', true]]),
    })
    expect(isPlanSatisfied(plan, generous)).toBe(false)
  })

  it('one uncheckable event sinks an otherwise satisfied batch', () => {
    const plan: Command[] = [
      {
        kind: 'EmitEvents',
        events: [
          { kind: 'cell.waive', fileId: FILE, cellId: CELL, payload: { ruleId: 'r-1' } },
          { kind: 'file.rename', fileId: FILE, payload: { name: 'renamed' } },
        ],
      },
    ]
    const state = live({ waivedRules: new Map([[cellKey(FILE, CELL), new Set(['r-1'])]]) })
    expect(isPlanSatisfied(plan, state)).toBe(false)
    const [verdict] = explainPlanSatisfaction(plan, state)
    expect(verdict.reason).toContain('events[1] (file.rename)')
  })
})

describe('isPlanSatisfied — never-satisfiable kinds and whole-plan composition', () => {
  it.each([
    ['PlanImport', { kind: 'PlanImport', fileName: 'F', fileType: 'usfm', cells: [] } as Command],
    ['CreateProject', { kind: 'CreateProject', name: 'P' } as Command],
    ['LinkMedia', { kind: 'LinkMedia', fileId: FILE, cellId: CELL, artifactId: 'a-1' } as Command],
    [
      'UpdateProjectSettings',
      { kind: 'UpdateProjectSettings', projectId: 'p1', settings: {}, ifMatchVersion: 1 } as Command,
    ],
  ])('%s is never satisfied by inspection', (_label, command) => {
    expect(isPlanSatisfied([command], live({ settings: {} }))).toBe(false)
  })

  it('an empty plan is not satisfied', () => {
    expect(isPlanSatisfied([], live())).toBe(false)
  })

  it('a plan is satisfied only when EVERY command is', () => {
    const state = live({
      targetValues: targets([
        [laneCellKey(FILE, 'cell-1'), { value: 'uno', valueHtml: null }],
        [laneCellKey(FILE, 'cell-2'), { value: 'dos', valueHtml: null }],
      ]),
    })
    const bothMatch: Command[] = [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'uno' },
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-2', value: 'dos' },
    ]
    expect(isPlanSatisfied(bothMatch, state)).toBe(true)

    const oneDiffers: Command[] = [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'uno' },
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-2', value: 'TRES' },
    ]
    expect(isPlanSatisfied(oneDiffers, state)).toBe(false)
    const verdicts = explainPlanSatisfaction(oneDiffers, state)
    expect(verdicts.map((v) => v.satisfied)).toEqual([true, false])
    expect(verdicts[1].reason).toContain('differs')
  })
})
