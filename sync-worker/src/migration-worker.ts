// Dedicated migration ingestion entry point. No application, R2 or provisioning
// routes, transport selector, fixture clocks, fault injection or Hyperdrive.
import { makePostgres, DEFAULT_STATEMENT_TIMEOUT_MS, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS } from '../../db/shim/postgres'
import { projectIdFor } from '../../src/lib/migrate/ids'
import { handleMigrateIngestRequest } from './events/migrate-ingest-route'
import { handleMigrateFinalizeRequest } from './events/migrate-finalize-route'
import { handleMigrateProjectRequest } from './events/migrate-project-route'
import { isAuthorizedAdminBearer } from './lib/admin-auth'
import { migrateFenceResponse } from './lib/migrate-fence'
import type { PosthogLogEnv } from './posthog-logs'

export interface MigrationWorkerEnv extends PosthogLogEnv {
  MIGRATION_DATABASE_URL: string
  MIGRATION_EXPECTED_HOST: string
  MIGRATION_EXPECTED_DATABASE: string
  MIGRATION_EXPECTED_ROLE: string
  /** Default off. Readiness works while writes are disabled. */
  MIGRATION_WRITES_ENABLED?: string
  /** Explicit source numeric IDs for canaries; "all" requires an intentional rollout. */
  MIGRATION_ALLOWED_GITLAB_IDS?: string
  ADMIN_SECRET: string
}
export const MIGRATION_CONTRACT_VERSION = 1
const MAX_BODY_BYTES = 4 * 1024 * 1024

function connectionString(env: MigrationWorkerEnv): string {
  const url = new URL(env.MIGRATION_DATABASE_URL)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !/^[a-z0-9-]+-pooler\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname)
    || url.hostname !== env.MIGRATION_EXPECTED_HOST || url.port
    || decodeURIComponent(url.pathname.slice(1)) !== env.MIGRATION_EXPECTED_DATABASE
    || !env.MIGRATION_EXPECTED_DATABASE || !env.MIGRATION_EXPECTED_ROLE
    || decodeURIComponent(url.username) !== env.MIGRATION_EXPECTED_ROLE || !url.password
    || url.searchParams.get('sslmode') !== 'require'
    || [...url.searchParams.keys()].some(k => k !== 'sslmode')) {
    throw new Error('Invalid pinned migration database configuration')
  }
  return url.toString()
}

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new Error('body limit')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('missing body')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('body limit') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder().decode(bytes))
}

// Factory permits real-Postgres route tests without opening external connections.
export function createMigrationWorker(connect: (uri: string) => AquillaDb = uri => makePostgres(uri, 1, { transactionLocalTimeouts: true })) {
  return { async fetch(request: Request, env: MigrationWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const method = new Map([['/migrate/readiness', 'GET'], ['/migrate/ingest', 'POST'], ['/migrate/finalize', 'POST']]).get(url.pathname)
    if (!method) return new Response('not found', { status: 404 })
    if (request.method !== method) return new Response('method not allowed', { status: 405 })
    // Dedicated operator credential is mandatory; no signing-key fallback.
    if (!env.ADMIN_SECRET) return new Response('migration service not configured', { status: 503 })
    if (!isAuthorizedAdminBearer(request.headers.get('Authorization') ?? '', env)) return new Response('unauthorized', { status: 401 })
    const fence = migrateFenceResponse(request, env, ctx)
    if (fence) return fence
    if (url.search) return new Response('query parameters are not supported', { status: 400 })
    const readiness = url.pathname === '/migrate/readiness'
    if (!readiness && env.MIGRATION_WRITES_ENABLED !== 'true') return new Response('migration writes disabled', { status: 503 })
    let body: Record<string, unknown> = {}
    let identity: { gitlabId: string; orgId: string; teamId: string | null } | undefined
    if (!readiness) {
      try {
        const parsed = await readBody(request)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid object')
        body = parsed as Record<string, unknown>
      } catch { return new Response('invalid or oversized JSON body', { status: 400 }) }
      const gitlabId = request.headers.get('x-migrate-gitlab-id') ?? ''
      const orgId = request.headers.get('x-migrate-org-id') ?? ''
      const teamId = request.headers.get('x-migrate-team-id')
      if (!/^[1-9][0-9]*$/.test(gitlabId) || !Number.isSafeInteger(Number(gitlabId))
        || body.projectId !== projectIdFor(gitlabId, 'gitlab')
        || !/^[1-9][0-9]*$/.test(orgId) || !Number.isSafeInteger(Number(orgId))
        || (teamId !== null && (!/^[1-9][0-9]*$/.test(teamId) || !Number.isSafeInteger(Number(teamId))))) {
        return new Response('invalid source identity or placement', { status: 400 })
      }
      const allowed = env.MIGRATION_ALLOWED_GITLAB_IDS?.split(',').map(id => id.trim()) ?? []
      if (!allowed.includes('all') && !allowed.includes(gitlabId)) return new Response('project outside rollout scope', { status: 403 })
      if (url.pathname === '/migrate/ingest' && (!Array.isArray(body.events) || body.events.length > 250 || body.events.some(e => !e || typeof e !== 'object' || Array.isArray(e)) || body.eventsOnly === true)) {
        return new Response('maximum 250 events; projections required', { status: 400 })
      }
      identity = { gitlabId, orgId, teamId }
    }
    let db: AquillaDb | undefined
    let phase = 'configuration'
    try {
      db = connect(connectionString(env))
      phase = 'database-verification'
      // Actual database/role and effective timeouts, not only URI labels.
      const target = await db.prepare(`SELECT current_database() AS database, current_user AS role,
        (SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout') AS statement_ms,
        (SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle_ms`).first<{
          database: string; role: string; statement_ms: number; idle_ms: number
        }>()
      if (!target || target.database !== env.MIGRATION_EXPECTED_DATABASE || target.role !== env.MIGRATION_EXPECTED_ROLE
        || Number(target.statement_ms) !== DEFAULT_STATEMENT_TIMEOUT_MS || Number(target.idle_ms) !== DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS) {
        throw new Error('Migration database identity or timeout mismatch')
      }
      const destination = `${env.MIGRATION_EXPECTED_HOST}/${target.database}/${target.role}`
      if (!readiness && request.headers.get('x-migrate-destination') !== destination) return new Response('destination mismatch', { status: 409 })
      if (readiness) return Response.json({ contractVersion: MIGRATION_CONTRACT_VERSION, destination, writesEnabled: env.MIGRATION_WRITES_ENABLED === 'true', maxEvents: 250 }, { headers: { 'Cache-Control': 'no-store' } })
      // Shared handlers require this compatibility slot, but this worker never
      // needs the application token-signing key. The operator secret fills it.
      phase = 'project-verification'
      const service = { ...env, SYNC_SECRET_KEY: env.ADMIN_SECRET, AQUILLA_PG: db, MIGRATION_BULK_SOURCE: true }
      const params = new URLSearchParams({ gitlabId: identity!.gitlabId, projectId: String(body.projectId), orgId: identity!.orgId, mustExist: 'true' })
      if (identity!.teamId !== null) params.set('teamId', identity!.teamId)
      const verified = await handleMigrateProjectRequest(new Request(`${url.origin}/migrate/project?${params}`, { headers: request.headers }), service)
      if (!verified || verified.status !== 200) return verified ?? new Response('identity verification failed', { status: 503 })
      const forwarded = new Request(url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) })
      phase = 'write'
      const response = url.pathname === '/migrate/ingest'
        ? await handleMigrateIngestRequest(forwarded, service)
        : await handleMigrateFinalizeRequest(forwarded, service)
      if (!response) return new Response('not found', { status: 404 })
      const headers = new Headers(response.headers)
      headers.set('x-migrate-destination', destination)
      headers.set('Cache-Control', 'no-store')
      return new Response(response.body, { status: response.status, headers })
    } catch (error) {
      // Do not send connection URIs, credentials, query parameters or driver errors.
      const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      const code = /^[A-Z0-9_]{1,40}$/.test(rawCode) ? rawCode : undefined
      console.error('[migration-direct] database request failed', { path: url.pathname, phase, code })
      return new Response('migration database unavailable or configuration mismatch', { status: 503 })
    } finally {
      if (db) ctx.waitUntil(db.close())
    }
  } }
}
export default createMigrationWorker()
