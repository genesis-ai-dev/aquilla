// Tests for the Monday push nudge (monday-notify.ts): frame classification and
// the best-effort POST to identity's /api/v2/monday/internal/push.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProjectDoServerMessage } from '../project-do-handlers'
import { mondayNotifyProject, notifyMondayProgress } from '../monday-notify'

const AUTH_URL = 'https://identity.test/identity'
const SECRET = 'sync-secret'

describe('mondayNotifyProject', () => {
  it('returns the project id for an event.applied frame', () => {
    const frames: ProjectDoServerMessage[] = [
      { t: 'event.applied', id: 'e1', kind: 'target.cell.commit', project: 'proj-1', cell: 'c1' },
    ]
    expect(mondayNotifyProject(frames)).toBe('proj-1')
  })

  it('returns the project id for a file.progress.updated frame', () => {
    const frames: ProjectDoServerMessage[] = [
      { t: 'file.progress.updated', project: 'proj-2', file: 'f1', fileCreated: true },
    ]
    expect(mondayNotifyProject(frames)).toBe('proj-2')
  })

  it('ignores presence/lock/member frames', () => {
    const frames: ProjectDoServerMessage[] = [
      { t: 'presence', users: [] },
      { t: 'lock.claimed', cellId: 'c1', by: { userId: 'u', ts: 1 } },
      { t: 'member.removed', project: 'proj-3', userId: 'u' },
    ]
    expect(mondayNotifyProject(frames)).toBeNull()
  })

  it('finds the content frame inside a mixed batch', () => {
    const frames: ProjectDoServerMessage[] = [
      { t: 'presence', users: [] },
      { t: 'event.applied', id: 'e2', kind: 'target.cell.commit', project: 'proj-4' },
    ]
    expect(mondayNotifyProject(frames)).toBe('proj-4')
  })
})

describe('notifyMondayProgress', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs the project id with the shared-secret bearer', async () => {
    await notifyMondayProgress({ AUTH_WORKER_URL: AUTH_URL, SYNC_SECRET_KEY: SECRET }, 'proj-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${AUTH_URL}/api/v2/monday/internal/push`)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(String(init.body))).toEqual({ projectId: 'proj-1' })
  })

  it('no-ops without AUTH_WORKER_URL or SYNC_SECRET_KEY', async () => {
    await notifyMondayProgress({ SYNC_SECRET_KEY: SECRET }, 'proj-1')
    await notifyMondayProgress({ AUTH_WORKER_URL: AUTH_URL }, 'proj-1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('swallows network failures (edit path must never throw)', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    await expect(
      notifyMondayProgress({ AUTH_WORKER_URL: AUTH_URL, SYNC_SECRET_KEY: SECRET }, 'proj-1'),
    ).resolves.toBeUndefined()
  })
})
