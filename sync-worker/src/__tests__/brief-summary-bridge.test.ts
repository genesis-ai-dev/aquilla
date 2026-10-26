// AQU-2191: the brief-summary render must reach the identity WORKER, not the
// zone origin.
//
// The regression this locks: the bridge used a global `fetch` to
// `AUTH_WORKER_URL` (`https://api.aquilla.app/identity`). From inside a Worker
// that same-zone request bypasses the Worker route and goes to the zone origin,
// which does not exist for an api.* host — so Cloudflare answered 522 on every
// attempt, the request never reached auth-worker, and nothing auth-worker could
// log showed the failure. DraftCells was binding-first and kept working, which
// is why the brief was the only surface broken.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderBriefSummary } from '../external/brief-summary-bridge'

const AUTH_URL = 'https://api.aquilla.app/identity'
const INPUT = { projectId: 'proj-1', userId: 7, l2Markdown: '## Audience\nReaders.' }

function okResponse() {
  return new Response(JSON.stringify({ summary: 'A brief.', model: 'm/1', truncated: false }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

let globalFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  globalFetch = vi.fn(async () => okResponse())
  vi.stubGlobal('fetch', globalFetch)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('renderBriefSummary transport (AQU-2191)', () => {
  it('calls the AUTH_WORKER service binding and never the zone origin', async () => {
    const binding = vi.fn(async () => okResponse())
    const result = await renderBriefSummary(
      { AUTH_WORKER_URL: AUTH_URL, SYNC_SECRET_KEY: 's', AUTH_WORKER: { fetch: binding } },
      INPUT,
    )

    expect(result).toMatchObject({ ok: true, summary: 'A brief.', model: 'm/1' })
    expect(binding).toHaveBeenCalledTimes(1)
    expect(binding.mock.calls[0][0]).toBe(`${AUTH_URL}/api/v1/ai/agent/internal/brief-summary`)
    // The zone-origin path is the bug — it must not be taken when bound.
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('falls back to global fetch when no binding exists (local dev, self-hosted)', async () => {
    const result = await renderBriefSummary({ AUTH_WORKER_URL: AUTH_URL, SYNC_SECRET_KEY: 's' }, INPUT)

    expect(result).toMatchObject({ ok: true })
    expect(globalFetch).toHaveBeenCalledTimes(1)
  })

  it('names the wiring on a Cloudflare-generated status instead of asking for a retry', async () => {
    for (const status of [520, 521, 522, 523, 524, 525, 526, 527, 530]) {
      const binding = vi.fn(async () => new Response('<html>error 522</html>', { status }))
      const result = await renderBriefSummary(
        { AUTH_WORKER_URL: AUTH_URL, SYNC_SECRET_KEY: 's', AUTH_WORKER: { fetch: binding } },
        INPUT,
      )

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('not_configured')
      expect(result.message).toContain(String(status))
      expect(result.message).toContain('api.aquilla.app')
      expect(result.message).toContain('AUTH_WORKER service binding')
      expect(result.message).toContain('retrying the render will not clear this')
    }
  })

  it('still reports an auth-worker-generated 5xx as job_failed', async () => {
    const binding = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'job_failed', message: 'brief summary model failed (502)' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const result = await renderBriefSummary(
      { AUTH_WORKER_URL: AUTH_URL, SYNC_SECRET_KEY: 's', AUTH_WORKER: { fetch: binding } },
      INPUT,
    )

    expect(result).toMatchObject({ ok: false, code: 'job_failed' })
  })

  it('logs every failure with a findable prefix so the render is not silent', async () => {
    const binding = vi.fn(async () => new Response('<html>error 522</html>', { status: 522 }))
    await renderBriefSummary(
      { AUTH_WORKER_URL: AUTH_URL, SYNC_SECRET_KEY: 's', AUTH_WORKER: { fetch: binding } },
      INPUT,
    )

    expect(console.error).toHaveBeenCalledWith(
      '[brief-summary-render] failed',
      expect.stringContaining('"status":522'),
    )
    expect(console.error).toHaveBeenCalledWith(
      '[brief-summary-render] failed',
      expect.stringContaining('"projectId":"proj-1"'),
    )
  })
})
