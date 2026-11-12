// Tests for the Monday push nudge (monday-notify.ts): frame classification and
// the best-effort POST to identity's /api/v2/monday/internal/push.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProjectDoServerMessage } from '../project-do-handlers'
import {
  mondayNotifyProject,
  notifyMondayProgress,
  handleMondayLinkChangedRequest,
} from '../monday-notify'

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
    expect(await notifyMondayProgress({ SYNC_SECRET_KEY: SECRET }, 'proj-1')).toBeNull()
    expect(await notifyMondayProgress({ AUTH_WORKER_URL: AUTH_URL }, 'proj-1')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('swallows network failures (edit path must never throw)', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    // AQU-1828: resolves to null — "we could not find out" — rather than
    // throwing or claiming the project is unlinked.
    await expect(
      notifyMondayProgress({ AUTH_WORKER_URL: AUTH_URL, SYNC_SECRET_KEY: SECRET }, 'proj-1'),
    ).resolves.toBeNull()
  })
})

// AQU-1828: the DO stops nudging identity for a project with no Monday link,
// so notifyMondayProgress has to report what identity answered.
describe('notifyMondayProgress — linked answer', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  const env = { AUTH_WORKER_URL: AUTH_URL, SYNC_SECRET_KEY: SECRET }

  it('returns false when identity says the project has no link', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, pushed: false, linked: false })),
    )
    expect(await notifyMondayProgress(env, 'proj-1')).toBe(false)
  })

  it('returns true when the project is linked', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, pushed: true, linked: true })),
    )
    expect(await notifyMondayProgress(env, 'proj-1')).toBe(true)
  })

  it('returns null — never a cacheable false — when the answer is unusable', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    expect(await notifyMondayProgress(env, 'proj-1')).toBeNull()

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, pushed: false })))
    expect(await notifyMondayProgress(env, 'proj-1')).toBeNull()

    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }))
    expect(await notifyMondayProgress(env, 'proj-1')).toBeNull()

    fetchMock.mockRejectedValue(new Error('boom'))
    expect(await notifyMondayProgress(env, 'proj-1')).toBeNull()

    expect(await notifyMondayProgress({ SYNC_SECRET_KEY: SECRET }, 'proj-1')).toBeNull()
  })
})

describe('handleMondayLinkChangedRequest', () => {
  const stubFetch = vi.fn()
  const doEnv = {
    SYNC_SECRET_KEY: SECRET,
    ProjectSync: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: stubFetch }),
    } as unknown as DurableObjectNamespace,
  }

  beforeEach(() => {
    stubFetch.mockReset().mockResolvedValue(Response.json({ ok: true }))
  })

  const post = (path: string, auth = `Bearer ${SECRET}`) =>
    new Request(`https://sync.test${path}`, { method: 'POST', headers: { Authorization: auth } })

  it('forwards the invalidation to the project DO', async () => {
    const res = await handleMondayLinkChangedRequest(
      post('/admin/projects/proj-1/monday-link-changed'),
      doEnv,
    )
    expect(res?.status).toBe(200)
    expect(stubFetch).toHaveBeenCalledTimes(1)
    const [url, init] = stubFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://do.internal/__monday-link-changed')
    expect(init.method).toBe('POST')
  })

  it('returns null for an unrelated path', async () => {
    expect(await handleMondayLinkChangedRequest(post('/admin/projects/p/settings-changed'), doEnv))
      .toBeNull()
  })

  it('rejects a wrong bearer without touching the DO', async () => {
    const res = await handleMondayLinkChangedRequest(
      post('/admin/projects/proj-1/monday-link-changed', 'Bearer wrong'),
      doEnv,
    )
    expect(res?.status).toBe(401)
    expect(stubFetch).not.toHaveBeenCalled()
  })

  it('swallows a DO failure (the link write already committed)', async () => {
    stubFetch.mockResolvedValue(new Response('boom', { status: 500 }))
    const res = await handleMondayLinkChangedRequest(
      post('/admin/projects/proj-1/monday-link-changed'),
      doEnv,
    )
    expect(res?.status).toBe(200)
  })
})
