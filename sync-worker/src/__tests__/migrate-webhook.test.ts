import { describe, it, expect } from 'vitest'
import { handleMigrateWebhookRequest } from '../events/migrate-webhook-route'

class FakeR2 {
  objects = new Map<string, string>()
  async put(key: string, body: string) { this.objects.set(key, body) }
  async delete(key: string) { this.objects.delete(key) }
  async get(key: string) { const b = this.objects.get(key); return b === undefined ? null : { text: async () => b } }
  async list(o: { prefix: string; startAfter?: string; limit?: number }) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(o.prefix) && (!o.startAfter || k > o.startAfter)).sort().slice(0, o.limit ?? 1000)
    return { objects: keys.map((key) => ({ key })), truncated: false }
  }
}
const env = () => ({ SNAPSHOTS: new FakeR2() as unknown as R2Bucket, GITLAB_WEBHOOK_SECRET: 'hook', SYNC_SECRET_KEY: 'sec' })
const push = (token: string, projectId = 47, after = 'abc') => new Request('https://s/migrate/webhook/gitlab', {
  method: 'POST', headers: { 'X-Gitlab-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ object_kind: 'push', ref: 'refs/heads/main', after, project: { id: projectId } }),
})

describe('/migrate/webhook', () => {
  it('rejects a bad token', async () => {
    const r = await handleMigrateWebhookRequest(push('nope'), env())
    expect(r?.status).toBe(401)
  })
  it('stores push events and lists them in order after a cursor', async () => {
    const e = env()
    expect((await handleMigrateWebhookRequest(push('hook', 1, 'a1'), e))?.status).toBe(204)
    expect((await handleMigrateWebhookRequest(push('hook', 2, 'b2'), e))?.status).toBe(204)
    const list = await handleMigrateWebhookRequest(new Request('https://s/migrate/webhook/inbox', { headers: { Authorization: 'Bearer sec' } }), e)
    const body = (await list!.json()) as { items: Array<{ gitlabId: number; sha: string; key: string }>; last: string }
    expect(body.items.map((i) => [i.gitlabId, i.sha])).toEqual([[1, 'a1'], [2, 'b2']])
    expect(body.items[0].key).toMatch(/^_migrate\/inbox\/\d{16}-1\.json$/)
    const list2 = await handleMigrateWebhookRequest(new Request(`https://s/migrate/webhook/inbox?after=${encodeURIComponent(body.items[0].key)}`, { headers: { Authorization: 'Bearer sec' } }), e)
    expect(((await list2!.json()) as { items: unknown[] }).items).toHaveLength(1)
  })
  it('prunes acked keys (<= the cursor) before listing', async () => {
    const e = env()
    for (const id of [1, 2, 3]) expect((await handleMigrateWebhookRequest(push('hook', id, `s${id}`), e))?.status).toBe(204)
    const r2 = e.SNAPSHOTS as unknown as FakeR2
    const keys = [...r2.objects.keys()].sort()
    const cursor = keys[1]
    const list = await handleMigrateWebhookRequest(
      new Request(`https://s/migrate/webhook/inbox?after=${encodeURIComponent(cursor)}`, { headers: { Authorization: 'Bearer sec' } }), e)
    expect(((await list!.json()) as { items: unknown[] }).items).toHaveLength(1)
    // The cursor is an ack: everything at or before it is gone, so the prefix
    // cannot grow without bound.
    expect([...r2.objects.keys()]).toEqual([keys[2]])
  })

  it('caps the page size at 200 so the Worker cannot blow the subrequest limit', async () => {
    const e = env()
    for (let i = 0; i < 205; i++) expect((await handleMigrateWebhookRequest(push('hook', i, `s${i}`), e))?.status).toBe(204)
    const list = await handleMigrateWebhookRequest(
      new Request('https://s/migrate/webhook/inbox?limit=1000', { headers: { Authorization: 'Bearer sec' } }), e)
    expect(((await list!.json()) as { items: unknown[] }).items).toHaveLength(200)
  })

  it('rejects an oversize body with 413', async () => {
    const e = env()
    const body = JSON.stringify({ object_kind: 'push', after: 'a'.repeat(70 * 1024), project: { id: 1 } })
    const r = await handleMigrateWebhookRequest(new Request('https://s/migrate/webhook/gitlab', {
      method: 'POST', headers: { 'X-Gitlab-Token': 'hook', 'Content-Type': 'application/json' }, body,
    }), e)
    expect(r?.status).toBe(413)
    expect((e.SNAPSHOTS as unknown as FakeR2).objects.size).toBe(0)
  })

  it('rejects a token of a different length without comparing contents', async () => {
    expect((await handleMigrateWebhookRequest(push('hookhook'), env()))?.status).toBe(401)
  })

  it('ignores non-push, non-project events', async () => {
    const e = env()
    const r = await handleMigrateWebhookRequest(new Request('https://s/migrate/webhook/gitlab', { method: 'POST', headers: { 'X-Gitlab-Token': 'hook' }, body: JSON.stringify({ object_kind: 'issue' }) }), e)
    expect(r?.status).toBe(204)
    expect((e.SNAPSHOTS as unknown as FakeR2).objects.size).toBe(0)
  })
})
