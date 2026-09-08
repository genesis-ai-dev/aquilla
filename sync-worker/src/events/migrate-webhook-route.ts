// GitLab → daemon inbox. GitLab POSTs push/project hooks here; the migrate
// daemon polls GET /migrate/webhook/inbox. Storage is the SNAPSHOTS R2 bucket
// under _migrate/inbox/ so no new binding is needed. See docs/MIGRATE-DAEMON.md.
import { isAuthorizedAdminBearer } from '../lib/admin-auth'

const HOOK_PATH = '/migrate/webhook/gitlab'
const INBOX_PATH = '/migrate/webhook/inbox'
const PREFIX = '_migrate/inbox/'
// One R2 `get` per listed key, so the page size is bounded by the Worker
// subrequest cap (50 for the free tier, 1000 paid) — 200 keeps well clear.
const MAX_LIMIT = 200
/** Keys deleted per poll once the daemon acks a cursor. */
const PRUNE_BATCH = 100
/** GitLab push hooks are small; anything larger is not one. */
const MAX_BODY_BYTES = 64 * 1024

export interface MigrateWebhookEnv {
  SNAPSHOTS?: R2Bucket
  GITLAB_WEBHOOK_SECRET?: string
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
}
export interface InboxItem { key: string; gitlabId: number; sha: string; ts: number; kind: string }

interface PushHook { object_kind?: string; event_name?: string; ref?: string; after?: string; project?: { id?: number }; project_id?: number }

export async function handleMigrateWebhookRequest(request: Request, env: MigrateWebhookEnv): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname === HOOK_PATH) return receive(request, env)
  if (url.pathname === INBOX_PATH) return list(request, url, env)
  return null
}

async function receive(request: Request, env: MigrateWebhookEnv): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (!env.GITLAB_WEBHOOK_SECRET) return new Response('GITLAB_WEBHOOK_SECRET not configured', { status: 500 })
  if (!timingSafeEqual(request.headers.get('X-Gitlab-Token') ?? '', env.GITLAB_WEBHOOK_SECRET)) return new Response('unauthorized', { status: 401 })
  if (!env.SNAPSHOTS) return new Response('SNAPSHOTS not configured', { status: 500 })
  const declared = Number(request.headers.get('Content-Length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return new Response('payload too large', { status: 413 })
  let text: string
  try { text = await request.text() } catch { return new Response('invalid body', { status: 400 }) }
  if (text.length > MAX_BODY_BYTES) return new Response('payload too large', { status: 413 })
  let body: PushHook
  try { body = JSON.parse(text) as PushHook } catch { return new Response('invalid JSON', { status: 400 }) }
  const isPush = body.object_kind === 'push'
  const isProject = typeof body.event_name === 'string' && body.event_name.startsWith('project_')
  if (!isPush && !isProject) return new Response(null, { status: 204 })
  const gitlabId = isPush ? body.project?.id : body.project_id
  if (typeof gitlabId !== 'number') return new Response('missing project id', { status: 400 })
  const ts = Date.now()
  const item: InboxItem = { key: `${PREFIX}${String(ts).padStart(16, '0')}-${gitlabId}.json`, gitlabId, sha: isPush ? (body.after ?? '') : '', ts, kind: isPush ? 'push' : body.event_name! }
  await env.SNAPSHOTS.put(item.key, JSON.stringify(item))
  return new Response(null, { status: 204 })
}

async function list(request: Request, url: URL, env: MigrateWebhookEnv): Promise<Response> {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
  if (!isAuthorizedAdminBearer(request.headers.get('Authorization') ?? '', env)) return new Response('unauthorized', { status: 401 })
  if (!env.SNAPSHOTS) return new Response('SNAPSHOTS not configured', { status: 500 })
  const after = url.searchParams.get('after') ?? undefined
  const limit = Math.min(Number(url.searchParams.get('limit') ?? MAX_LIMIT) || MAX_LIMIT, MAX_LIMIT)
  // The cursor is an ack: everything at or before it has been consumed by the
  // daemon, so it can go. Without this the prefix grows forever.
  if (after) await prune(env.SNAPSHOTS, after)
  const listed = await env.SNAPSHOTS.list({ prefix: PREFIX, startAfter: after, limit })
  const items: InboxItem[] = []
  for (const o of listed.objects) {
    const obj = await env.SNAPSHOTS.get(o.key)
    if (obj) items.push(JSON.parse(await obj.text()) as InboxItem)
  }
  return Response.json({ items, last: items.length ? items[items.length - 1].key : undefined })
}

/** Best-effort delete of up to PRUNE_BATCH acked keys (<= `after`). */
async function prune(bucket: R2Bucket, after: string): Promise<void> {
  try {
    const stale = await bucket.list({ prefix: PREFIX, limit: PRUNE_BATCH })
    const doomed = stale.objects.filter((o) => o.key <= after).map((o) => o.key)
    await Promise.all(doomed.map((k) => bucket.delete(k).catch(() => undefined)))
  } catch { /* pruning is opportunistic; never fail the poll for it */ }
}

/** Constant-time string compare. `crypto.subtle.timingSafeEqual` is not
 *  available in Workers, so XOR every char and reject a length mismatch. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
