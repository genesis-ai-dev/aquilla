import { describe, it, expect } from 'vitest'
import {
  defaultLaneDraftReviewHref,
  draftReviewHref,
  editorCellHref,
  resolveDeepLinkLane,
  resolveDeepLinkLaneFromSearchParams,
} from './project-workspace-lane-deeplink'

// AQU-538: `/project/:id/editor?lane=<tag>` deep-link resolution.
describe('resolveDeepLinkLane', () => {
  const available = ['', 'es', 'fr']

  it('returns null when there is no lane param (leave current lane untouched)', () => {
    expect(resolveDeepLinkLane(null, available)).toBeNull()
    expect(resolveDeepLinkLane(undefined, available)).toBeNull()
  })

  it('treats an explicit empty lane param as an instruction to select Project default', () => {
    expect(resolveDeepLinkLane('', available)).toBe('')
  })

  it('returns the param when it is an available lane', () => {
    expect(resolveDeepLinkLane('es', available)).toBe('es')
    expect(resolveDeepLinkLane('fr', available)).toBe('fr')
  })

  it('falls back to the default lane for an unknown tag', () => {
    expect(resolveDeepLinkLane('de', available)).toBe('')
    expect(resolveDeepLinkLane('xx', ['', 'es'])).toBe('')
  })

  it('an N=1 project (only the default lane) rejects any non-empty tag', () => {
    expect(resolveDeepLinkLane('es', [''])).toBe('')
  })

  it('a review link overrides a persisted multilingual lane with explicit Project default', () => {
    const persistedLane = 'fr'
    const href = defaultLaneDraftReviewHref('p1', 'file/1', 'cell 2')
    const searchParams = new URL(href, 'https://app.test').searchParams
    const deepLinkLane = resolveDeepLinkLaneFromSearchParams(searchParams, available)

    expect(href).toBe('/project/p1/editor/file/file%2F1?cellId=cell%202&lane=')
    expect(deepLinkLane ?? persistedLane).toBe('')
  })
})

// AQU-1278: the Autopilot-only `draftReviewHref` became the general
// `editorCellHref` when the plan board became its second caller, and grew the
// `flash` flag so a "go to the first outstanding cell" link visibly ARRIVES.
describe('editorCellHref', () => {
  it('always emits a lane — an absent lane param means "leave the editor where it was"', () => {
    // The whole reason the empty lane is spelled out: `?lane=` selects Project
    // default, while NO lane param at all is read as "no deep-link intent".
    expect(editorCellHref('p1', 'f1', 'c1')).toBe('/project/p1/editor/file/f1?cellId=c1&lane=')
    expect(editorCellHref('p1', 'f1', 'c1', 'es')).toBe('/project/p1/editor/file/f1?cellId=c1&lane=es')
    expect(resolveDeepLinkLaneFromSearchParams(
      new URL(editorCellHref('p1', 'f1', 'c1', 'es'), 'https://app.test').searchParams,
      ['', 'es', 'fr'],
    )).toBe('es')
  })

  it('drops the cell segment when there is no cell (a plain "open this file" link)', () => {
    expect(editorCellHref('p1', 'f1')).toBe('/project/p1/editor/file/f1?lane=')
    expect(editorCellHref('p1', 'f1', null, 'fr')).toBe('/project/p1/editor/file/f1?lane=fr')
  })

  it('appends flash=1 only when asked, and only alongside a cell', () => {
    expect(editorCellHref('p1', 'f1', 'c1', 'fr', true))
      .toBe('/project/p1/editor/file/f1?cellId=c1&lane=fr&flash=1')
    // Default is off: the comments deep-link arrives from a thread that already
    // names the cell and lands quietly, as it always has.
    expect(editorCellHref('p1', 'f1', 'c1', 'fr')).not.toContain('flash')
    // Nothing to flash without a row — ProjectWorkspace only reads the flag
    // inside its `if (cellId)` branch, so emitting it there would be a lie.
    expect(editorCellHref('p1', 'f1', null, 'fr', true)).toBe('/project/p1/editor/file/f1?lane=fr')
  })

  it('percent-encodes every segment it interpolates, flash included', () => {
    const href = editorCellHref('p 1', 'file/1', 'cell 2', 'zh-Hant', true)
    expect(href).toBe('/project/p%201/editor/file/file%2F1?cellId=cell%202&lane=zh-Hant&flash=1')
    const params = new URL(href, 'https://app.test').searchParams
    expect(params.get('cellId')).toBe('cell 2')
    expect(params.get('flash')).toBe('1')
  })

  it('keeps the deprecated names working for the callers that still use them', () => {
    // AutopilotActivityInspector still imports draftReviewHref; it must stay a
    // true alias (same arity, same output) rather than a reimplementation.
    expect(draftReviewHref).toBe(editorCellHref)
    expect(draftReviewHref('p1', 'f1', 'c1', 'es')).toBe(editorCellHref('p1', 'f1', 'c1', 'es'))
    expect(defaultLaneDraftReviewHref('p1', 'f1', 'c1')).toBe(editorCellHref('p1', 'f1', 'c1', ''))
  })
})
