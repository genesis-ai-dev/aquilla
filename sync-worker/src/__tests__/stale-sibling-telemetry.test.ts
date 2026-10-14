// AQU-1965: a stale sibling rides inside a 200 /events response and used to
// leave no server-side trace at all. It is now reported to PostHog Logs —
// grouped per cell, throttled, and with no user content.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  reportStaleSiblings,
  resetStaleSiblingTelemetryForTests,
  summarizeStaleSiblings,
  STALE_SIBLING_TELEMETRY_THROTTLE_MS,
} from '../events/stale-sibling-telemetry'

const ENV = { POSTHOG_KEY: 'phc_test', POSTHOG_HOST: 'https://eu.i.posthog.com' }

const PROJECT = 'proj-marathi-bsb'
const FILE = 'file-acts'
const CELL = 'cell-23'
const HEAD = 'event-head'

const events = [
  {
    id: 'e1',
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: HEAD,
    payload: { value: 'SECRET CELL TEXT', author: 'atul@example.test' },
  },
  {
    id: 'e2',
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: 'e1',
    payload: { value: 'more secret text' },
  },
  {
    id: 'e3',
    kind: 'source.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId: 'cell-24',
    parentId: 'other-head',
    payload: { value: 'fine' },
  },
]
const stale = [
  { id: 'e1', fileId: FILE, cellId: CELL },
  { id: 'e2', fileId: FILE, cellId: CELL },
  { id: 'e3', fileId: FILE, cellId: 'cell-24' },
]

interface ShippedLog {
  body: string
  severity: string
  attributes: Record<string, string | number>
}

function shippedLogs(fetchMock: ReturnType<typeof vi.fn>): ShippedLog[] {
  return fetchMock.mock.calls.map(([, init]) => {
    const payload = JSON.parse(String((init as RequestInit).body)) as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{
        body: { stringValue: string }
        severityText: string
        attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number } }>
      }> }> }>
    }
    const record = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!
    const attributes: Record<string, string | number> = {}
    for (const attr of record.attributes) {
      attributes[attr.key] = attr.value.stringValue ?? attr.value.intValue ?? attr.value.doubleValue ?? ''
    }
    return { body: record.body.stringValue, severity: record.severityText, attributes }
  })
}

describe('stale-sibling telemetry', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    resetStaleSiblingTelemetryForTests()
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('groups stale siblings by project, file, cell and kind', () => {
    expect(summarizeStaleSiblings(events, stale)).toEqual([
      {
        projectId: PROJECT, fileId: FILE, cellId: CELL, kind: 'target.cell.commit',
        eventId: 'e2', parentId: 'e1', count: 2,
      },
      {
        projectId: PROJECT, fileId: FILE, cellId: 'cell-24', kind: 'source.cell.commit',
        eventId: 'e3', parentId: 'other-head', count: 1,
      },
    ])
  })

  it('falls back to (unknown) when the entry names no cell or has no raw event', () => {
    expect(summarizeStaleSiblings([], [{ id: 'gone', fileId: null, cellId: null }])).toEqual([
      {
        projectId: '(unknown)', fileId: '(unknown)', cellId: '(unknown)', kind: '(unknown)',
        eventId: 'gone', parentId: '(unknown)', count: 1,
      },
    ])
  })

  it('ships one warn line per cell with the losing parent pin and no user content', async () => {
    const waitUntil = vi.fn()
    const shipped = reportStaleSiblings(ENV, { waitUntil }, events, stale, 1_000_000)
    expect(shipped).toHaveLength(2)
    expect(waitUntil).toHaveBeenCalledTimes(2)
    await Promise.all(waitUntil.mock.calls.map(([p]) => p))
    const logs = shippedLogs(fetchMock)
    expect(logs).toHaveLength(2)
    expect(logs[0]!.severity).toBe('WARN')
    expect(logs[0]!.attributes).toMatchObject({
      'events.project_id': PROJECT,
      'events.file_id': FILE,
      'events.cell_id': CELL,
      'events.kind': 'target.cell.commit',
      'events.stale_event_id': 'e2',
      'events.stale_parent_id': 'e1',
      'events.stale_count': 2,
      'events.request_stale': 3,
      'events.request_event_count': 3,
      'events.suppressed_since_last': 0,
    })
    const everything = JSON.stringify(fetchMock.mock.calls)
    expect(everything).not.toContain('SECRET CELL TEXT')
    expect(everything).not.toContain('more secret text')
    expect(everything).not.toContain('atul@example.test')
  })

  it('throttles per cell and reports the suppressed repeats — a poisoned chain is the climbing count', async () => {
    const waitUntil = vi.fn()
    const t0 = 2_000_000
    // Atul's cell: every retry loses the same way.
    const cellOnly = [stale[0]!]
    reportStaleSiblings(ENV, { waitUntil }, events, cellOnly, t0)
    for (let i = 1; i <= 5; i++) {
      expect(reportStaleSiblings(ENV, { waitUntil }, events, cellOnly, t0 + i * 5_000)).toEqual([])
    }
    expect(waitUntil).toHaveBeenCalledTimes(1)
    const after = reportStaleSiblings(
      ENV, { waitUntil }, events, cellOnly, t0 + STALE_SIBLING_TELEMETRY_THROTTLE_MS,
    )
    expect(after).toHaveLength(1)
    await Promise.all(waitUntil.mock.calls.map(([p]) => p))
    const logs = shippedLogs(fetchMock)
    expect(logs).toHaveLength(2)
    expect(logs[1]!.attributes['events.suppressed_since_last']).toBe(5)
  })

  it('does not let one cell throttle another', () => {
    const waitUntil = vi.fn()
    const t0 = 3_000_000
    expect(reportStaleSiblings(ENV, { waitUntil }, events, [stale[0]!], t0)).toHaveLength(1)
    expect(reportStaleSiblings(ENV, { waitUntil }, events, [stale[2]!], t0 + 1_000)).toHaveLength(1)
  })

  it('ships nothing for a request with no stale siblings, or without a PostHog key', async () => {
    const waitUntil = vi.fn()
    expect(reportStaleSiblings(ENV, { waitUntil }, events, [])).toEqual([])
    reportStaleSiblings({}, { waitUntil }, events, stale, 4_000_000)
    await Promise.all(waitUntil.mock.calls.map(([p]) => p))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
