// A per-event 5xx inside a 200 /events response is reported to PostHog Logs —
// grouped, throttled, and with no user content.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  dbFailureInfo,
  reportServerRejections,
  resetRejectionTelemetryForTests,
  summarizeServerRejections,
  REJECTION_TELEMETRY_THROTTLE_MS,
} from '../events/rejection-telemetry'

const ENV = { POSTHOG_KEY: 'phc_test', POSTHOG_HOST: 'https://eu.i.posthog.com' }

const events = [
  { id: 'e1', kind: 'target.cell.commit', projectId: 'proj-a', payload: { value: 'SECRET CELL TEXT' } },
  { id: 'e2', kind: 'cell.validate', projectId: 'proj-a', payload: { editEventId: 'e1' } },
  { id: 'e3', kind: 'target.cell.commit', projectId: 'proj-a', payload: { value: 'more text' } },
  { id: 'e4', kind: 'source.cell.commit', projectId: 'proj-a', payload: { value: 'fine' } },
]
const batchFailed = [
  { id: 'e1', status: 500, reason: 'DB batch failed' },
  { id: 'e2', status: 500, reason: 'DB batch failed' },
  { id: 'e3', status: 500, reason: 'DB batch failed' },
  { id: 'e4', status: 403, reason: 'role too low' },
]

interface ShippedLog {
  body: string
  attributes: Record<string, string | number>
}

function shippedLogs(fetchMock: ReturnType<typeof vi.fn>): ShippedLog[] {
  return fetchMock.mock.calls.map(([, init]) => {
    const payload = JSON.parse(String((init as RequestInit).body)) as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{
        body: { stringValue: string }
        attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number } }>
      }> }> }>
    }
    const record = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!
    const attributes: Record<string, string | number> = {}
    for (const attr of record.attributes) {
      attributes[attr.key] = attr.value.stringValue ?? attr.value.intValue ?? attr.value.doubleValue ?? ''
    }
    return { body: record.body.stringValue, attributes }
  })
}

describe('rejection telemetry', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    resetRejectionTelemetryForTests()
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('groups only 5xx rejections by project, kind, status and reason', () => {
    expect(summarizeServerRejections(events, batchFailed)).toEqual([
      { projectId: 'proj-a', kind: 'target.cell.commit', status: 500, reason: 'DB batch failed', count: 2 },
      { projectId: 'proj-a', kind: 'cell.validate', status: 500, reason: 'DB batch failed', count: 1 },
    ])
  })

  it('ships one line per group with counts, the pg code/table/column, and no user content', async () => {
    const waitUntil = vi.fn()
    const shipped = reportServerRejections(
      ENV,
      { waitUntil },
      events,
      batchFailed,
      { code: '23502', table: 'cells', column: 'lane_id' },
      1_000_000,
    )
    expect(shipped).toHaveLength(2)
    expect(waitUntil).toHaveBeenCalledTimes(2)
    await Promise.all(waitUntil.mock.calls.map(([p]) => p))
    const logs = shippedLogs(fetchMock)
    expect(logs).toHaveLength(2)
    expect(logs[0]!.attributes).toMatchObject({
      'events.project_id': 'proj-a',
      'events.kind': 'target.cell.commit',
      'events.status': 500,
      'events.reason': 'DB batch failed',
      'events.rejected_count': 2,
      'events.request_rejected_5xx': 3,
      'events.request_event_count': 4,
      'events.suppressed_since_last': 0,
      'db.error_code': '23502',
      'db.table': 'cells',
      'db.column': 'lane_id',
    })
    const everything = JSON.stringify(fetchMock.mock.calls)
    expect(everything).not.toContain('SECRET CELL TEXT')
    expect(everything).not.toContain('more text')
  })

  it('throttles a retry loop per group and reports what it suppressed on the next line', async () => {
    const waitUntil = vi.fn()
    const t0 = 2_000_000
    reportServerRejections(ENV, { waitUntil }, events, batchFailed, null, t0)
    // The outbox retries the same failing batch every few seconds.
    for (let i = 1; i <= 5; i++) {
      expect(reportServerRejections(ENV, { waitUntil }, events, batchFailed, null, t0 + i * 5_000)).toEqual([])
    }
    expect(waitUntil).toHaveBeenCalledTimes(2)
    const after = reportServerRejections(
      ENV, { waitUntil }, events, batchFailed, null, t0 + REJECTION_TELEMETRY_THROTTLE_MS,
    )
    expect(after).toHaveLength(2)
    await Promise.all(waitUntil.mock.calls.map(([p]) => p))
    const logs = shippedLogs(fetchMock)
    expect(logs).toHaveLength(4)
    const commitLine = logs.find((log, i) => i >= 2 && log.attributes['events.kind'] === 'target.cell.commit')
    expect(commitLine?.attributes['events.suppressed_since_last']).toBe(10)
  })

  it('ships nothing for a request with no 5xx, or without a PostHog key', async () => {
    const waitUntil = vi.fn()
    expect(reportServerRejections(ENV, { waitUntil }, events, [{ id: 'e4', status: 422, reason: 'unknown lane' }])).toEqual([])
    reportServerRejections({}, { waitUntil }, events, batchFailed, null, 3_000_000)
    await Promise.all(waitUntil.mock.calls.map(([p]) => p))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps only identifier-shaped pg fields and never the message', () => {
    const err = Object.assign(new Error('invalid input syntax for type bigint: "1.5"'), {
      code: '22P02', table: 'cells', column: 'start ms; drop',
    })
    expect(dbFailureInfo(err)).toEqual({ code: '22P02', table: 'cells', column: undefined })
    expect(dbFailureInfo('boom')).toEqual({})
  })
})
