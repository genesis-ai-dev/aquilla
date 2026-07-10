import { describe, expect, it } from 'vitest'
import { handleProjectSettingsChangedRequest } from '../project-settings-notify'

const SECRET = 'settings-notify-secret'

describe('project settings realtime notification', () => {
  it('authenticates identity and broadcasts the version through ProjectSync', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const env = {
      SYNC_SECRET_KEY: SECRET,
      ProjectSync: {
        idFromName: (projectId: string) => projectId,
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            calls.push({ url, init })
            return Response.json({ ok: true })
          },
        }),
      },
    } as unknown as Parameters<typeof handleProjectSettingsChangedRequest>[1]

    const response = await handleProjectSettingsChangedRequest(new Request(
      'https://worker/admin/projects/project-1/settings-changed',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 7 }),
      },
    ), env)

    expect(response?.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://do.internal/__broadcast')
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      t: 'project.settings.updated', project: 'project-1', version: 7,
    })
  })

  it('rejects unauthenticated and malformed requests before touching the DO', async () => {
    const env = { SYNC_SECRET_KEY: SECRET } as Parameters<typeof handleProjectSettingsChangedRequest>[1]
    const unauthorized = await handleProjectSettingsChangedRequest(new Request(
      'https://worker/admin/projects/project-1/settings-changed', { method: 'POST' },
    ), env)
    expect(unauthorized?.status).toBe(401)

    const malformed = await handleProjectSettingsChangedRequest(new Request(
      'https://worker/admin/projects/project-1/settings-changed', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'seven' }),
      },
    ), env)
    expect(malformed?.status).toBe(400)
  })
})
