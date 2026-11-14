// DriveFolderPoller — one Durable Object per linked Drive folder.
//
// Its only job is the clock: an alarm every DRIVE_POLL_INTERVAL_MS runs one
// `syncDriveFolderLink` pass and sets the next alarm. A cron cannot do this —
// its floor is one minute and a local `wrangler dev` never fires it — while an
// alarm runs the same locally and deployed. The only stored state is the link
// id; everything else lives in Postgres. When the link row is gone the object
// clears its storage and stops.
//
//   POST /start      {linkId} — remember the link and poll now
//   POST /sync-now   — run one pass and return its result (the "Sync now" button)

import { DurableObject } from 'cloudflare:workers'
import { makePostgres } from '../../../db/shim/postgres'
import { setAccessGrantsMode } from '../../../db/shared/project-roles'
import { withStoreSecrets } from '../../../db/shared/secrets-store-overlay'
import { serviceBearerMatches } from '../lib/service-auth'
import { syncDriveFolderLink, type DriveSyncEnv, type DriveSyncResult } from './drive-folder-sync'

const DEFAULT_INTERVAL_MS = 15_000
/** Back off to this after a failed pass, so a broken share or key does not
 *  hammer Google every 15 seconds. */
const ERROR_INTERVAL_MS = 60_000

export function drivePollIntervalMs(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 5_000 ? n : DEFAULT_INTERVAL_MS
}

export class DriveFolderPoller extends DurableObject<Cloudflare.Env> {
  async fetch(request: Request): Promise<Response> {
    if (!serviceBearerMatches(request.headers.get('Authorization'), await withStoreSecrets(this.env))) return new Response('unauthorized', { status: 401 })
    const path = new URL(request.url).pathname
    if (path === '/start' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { linkId?: unknown } | null
      if (typeof body?.linkId !== 'string') return new Response('linkId required', { status: 400 })
      await this.ctx.storage.put('linkId', body.linkId)
      await this.ctx.storage.setAlarm(Date.now())
      return Response.json({ ok: true })
    }
    if (path === '/sync-now' && request.method === 'POST') {
      const result = await this.runPass()
      return Response.json(result ?? { linked: false })
    }
    return new Response('not found', { status: 404 })
  }

  async alarm(): Promise<void> {
    let result: DriveSyncResult | null = null
    let threw = false
    try {
      result = await this.runPass()
    } catch (err) {
      threw = true
      console.error('[drive-sync] pass failed:', err)
    }
    // No link stored, or the link row is gone: stop polling.
    if (!threw && (!result || !result.linked)) return
    const env = await withStoreSecrets(this.env)
    const interval = result && result.errors.length === 0
      ? drivePollIntervalMs(env.DRIVE_POLL_INTERVAL_MS)
      : ERROR_INTERVAL_MS
    await this.ctx.storage.setAlarm(Date.now() + interval)
  }

  private running: Promise<DriveSyncResult | null> | null = null

  /** One pass at a time: a "Sync now" during an alarm pass joins it, so two
   *  passes never both see a new Drive file as unseen and create it twice. */
  private runPass(): Promise<DriveSyncResult | null> {
    this.running ??= this.pass().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** Null when the object holds no link. Clears itself when the link is gone. */
  private async pass(): Promise<DriveSyncResult | null> {
    const linkId = await this.ctx.storage.get<string>('linkId')
    if (!linkId) return null
    const env = await withStoreSecrets(this.env)
    if (!env.HYPERDRIVE) throw new Error('HYPERDRIVE not bound')
    // Per invocation: a socket pool shared across requests throws in Workers.
    const shim = makePostgres(env.HYPERDRIVE.connectionString)
    const db = shim as unknown as AquillaDb
    setAccessGrantsMode(db, env.ACCESS_GRANTS_RESOLVER)
    try {
      const runEnv = { ...env, AQUILLA_PG: db } as unknown as DriveSyncEnv
      const result = await syncDriveFolderLink(runEnv, linkId, { ctx: this.ctx as unknown as ExecutionContext })
      if (!result.linked) {
        await this.ctx.storage.deleteAlarm()
        await this.ctx.storage.deleteAll()
      } else if (result.created.length + result.revised.length + result.errors.length > 0) {
        console.log(
          `[drive-sync] link=${linkId} created=${result.created.length} revised=${result.revised.length} errors=${result.errors.length}`,
        )
      }
      return result
    } finally {
      this.ctx.waitUntil(shim.close())
    }
  }
}
