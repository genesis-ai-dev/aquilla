// review-telemetry — PostHog events for validations and audio the Agent API
// commits (AQU-1572).
//
// The browser reports what a person does in the app, one event per line, from
// its emit seam (src/lib/cell-telemetry.ts, called in src/lib/sync/events-emit.ts).
// A changeset committed through the Agent API — REST, MCP, or the in-app
// agent's plan applied from a review card through the session route — lands
// here, server-side, and no browser ever sees the write. So this worker is the
// only place it can be counted. The events come from the SAME builders the
// browser uses (src/lib/review-events.ts): same names, same properties, one
// event per line, so a validation reads the same in PostHog whoever made it.
// What only this side knows: `surface: 'api'`, and `auto: false` (the Agent
// API never votes by itself; every event in a plan was asked for).
//
// When it fires: only after a changeset's terminal `committed` write, and only
// for the events the /events perimeter accepted. A staged plan, an approval
// (which mints a confirmation and applies nothing), a stale or refused commit,
// and the idempotent re-commit of an already-committed plan all send nothing.
// Writes through the browser's own POST /events never reach this module: the
// browser reports those itself, and reporting both would double-count.
//
// Data policy: the builders' — ids only, and a cell id only when it is an
// opaque UUID. No cell text, file name, artifact id, audio id or URL.
//
// Consent: the browser's analytics switch lives in that browser's localStorage
// (src/lib/analytics-consent.ts), which no worker can read. REST and MCP
// commits have no browser behind them, so, like auth-worker's agent telemetry,
// they do not consult it. A session ('app') commit does: a person in the app
// applies the in-app agent's plan from the review card, so the card states
// that browser's switch on the commit request (`?analytics=on`) and the worker
// sends nothing without it — see reviewTelemetryAllowed.
//
// Contract, same as auth-worker's agent telemetry (AQU-1467): one request per
// commit, never throws, never delays the response (ctx.waitUntil), and a no-op
// when POSTHOG_KEY is blank. It is "" in production's wrangler.toml until the
// EU project token lands (AQU-854) and unset elsewhere, so this ships inert.

import { resolvePosthogHost } from '../posthog-logs'
import {
  audioActionEvent,
  cellValidationEvent,
  type TelemetryEvent,
  type TelemetrySource,
  type ValidationMedium,
} from '../../../src/lib/review-events'
import { laneCellKey } from './cell-keys'
import type { ExternalEnv, ProvenanceChannel } from './types'

export type ReviewTelemetryEnv = Pick<ExternalEnv, 'POSTHOG_KEY' | 'POSTHOG_HOST' | 'ENVIRONMENT'>

const LIB = 'aquilla-sync-worker'
const FLUSH_TIMEOUT_MS = 3000

/** Every Agent API event says it came through the API, whoever held the token. */
const API_SURFACE = 'api' as const

/**
 * Who acted, from the channel the commit arrived on. REST is any integration
 * holding a PAT, which we cannot tell from an agent: "api". MCP is an AI client
 * by construction, and 'app' is the session route the in-app agent's staged
 * plans are applied through (LiveChangesetCard → commitChangeset): "agent".
 */
export function telemetrySourceFor(channel: ProvenanceChannel): TelemetrySource {
  return channel === 'rest' ? 'api' : 'agent'
}

/**
 * AQU-1572 review: may this commit report to PostHog at all? A session ('app')
 * commit is a person in the browser, so it reports only when the review card
 * says that person's analytics switch is on (`?analytics=on` on the commit
 * request; a query parameter, not a header, so the browser's CORS preflight is
 * unaffected). Anything else, including an older client that says nothing,
 * reads as off. REST and MCP have no browser switch to honour.
 */
export function reviewTelemetryAllowed(request: Pick<Request, 'url'>, channel: ProvenanceChannel): boolean {
  if (channel !== 'app') return true
  try {
    return new URL(request.url).searchParams.get('analytics') === 'on'
  } catch {
    return false
  }
}

/** The event kinds that change an approval, and which approval. */
const VALIDATION_KINDS: Readonly<Record<string, { medium: ValidationMedium; validated: boolean }>> = {
  'cell.validate': { medium: 'text', validated: true },
  'cell.unvalidate': { medium: 'text', validated: false },
  // Not on the EmitEvents allowlist today (commands-emit-events.ts), so no
  // Agent API path produces them yet. Mapped so that the day they are allowed
  // they report as audio approvals instead of vanishing.
  'cell.audio.validate': { medium: 'audio', validated: true },
  'cell.audio.unvalidate': { medium: 'audio', validated: false },
}

/** One applied plan event, as EmitEvents stores it. */
export interface AppliedPlanEvent {
  kind: string
  fileId?: string
  cellId?: string
  /** The lane's tag, canonical: '' (or absent) is the default lane. */
  laneId?: string
}

/**
 * The validation events for one committed EmitEvents batch: one per line, as
 * the browser reports them. A line named twice for the same kind is one line.
 * `applied` must hold only the events the perimeter accepted.
 */
export function emitEventsTelemetry(
  projectId: string,
  applied: readonly AppliedPlanEvent[],
  source: TelemetrySource,
): TelemetryEvent[] {
  const seen = new Set<string>()
  const out: TelemetryEvent[] = []
  for (const e of applied) {
    const kind = VALIDATION_KINDS[e.kind]
    if (!kind || !e.fileId || !e.cellId) continue
    const key = `${e.kind}\u0000${laneCellKey(e.fileId, e.cellId, e.laneId)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cellValidationEvent(kind.validated, {
      medium: kind.medium,
      projectId,
      fileId: e.fileId,
      cellId: e.cellId,
      lane: e.laneId ?? '',
      source,
      auto: false,
      surface: API_SURFACE,
    }))
  }
  return out
}

/** One `audio attached` per line a committed LinkMedia changeset attached to.
 *  LinkMedia always lands in the shared `recording` slot, with no lane, and
 *  the artifact carries no duration (upload does no decoding, see
 *  artifacts-route.ts), so none is sent. */
export function linkMediaTelemetry(
  projectId: string,
  attached: ReadonlyArray<{ fileId: string; cellId: string }>,
  source: TelemetrySource,
): TelemetryEvent[] {
  return attached.map((a) => audioActionEvent({
    origin: 'attach',
    projectId,
    fileId: a.fileId,
    cellId: a.cellId,
    slot: 'recording',
    lane: '',
    source,
    surface: API_SURFACE,
  }))
}

/**
 * The browser's `app_env` vocabulary (src/lib/analytics-env.ts) for this
 * worker's ENVIRONMENT, so one dashboard filter splits both sources. Only the
 * dev deployment is spelled differently ("development"); anything else passes
 * through as it is.
 */
export function telemetryAppEnv(environment: string | undefined): string | undefined {
  const env = environment?.trim()
  if (!env) return undefined
  return env === 'development' ? 'dev' : env
}

/** Hex SHA-256 of the username — exactly what the browser identifies as
 *  (src/hooks/useFrontierSession.ts), so server and browser events join on one
 *  person without the username itself leaving the worker. */
export async function telemetryDistinctId(username: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(username))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Send one commit's events in one request. Returns at once: the request rides
 * `ctx.waitUntil`, so the caller's response never waits on PostHog. Never
 * throws — dropped events cost a chart, never a commit.
 */
export function sendReviewTelemetry(
  env: ReviewTelemetryEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
  username: string,
  events: readonly TelemetryEvent[],
): void {
  try {
    const key = env.POSTHOG_KEY?.trim()
    if (events.length === 0) return
    if (!key) {
      // A local stack has no key, so nothing could otherwise be checked by
      // hand: print what would have gone, ids and counts only, to the stack log.
      if (env.ENVIRONMENT === 'local') {
        for (const e of events) console.info('[review-telemetry]', e.event, JSON.stringify(e.properties))
      }
      return
    }
    const sent = postBatch(key, resolvePosthogHost(env.POSTHOG_HOST), env.ENVIRONMENT, username, events)
    ctx?.waitUntil(sent)
  } catch {
    /* telemetry must not break the commit */
  }
}

async function postBatch(
  key: string,
  host: string,
  appEnv: string | undefined,
  username: string,
  events: readonly TelemetryEvent[],
): Promise<void> {
  try {
    const distinctId = await telemetryDistinctId(username)
    const timestamp = new Date().toISOString()
    const batch = events.map((e) => ({
      event: e.event,
      distinct_id: distinctId,
      properties: {
        ...e.properties,
        ...(telemetryAppEnv(appEnv) ? { app_env: telemetryAppEnv(appEnv) } : {}),
        $lib: LIB,
      },
      timestamp,
    }))
    const res = await fetch(`${host}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, batch }),
      signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
    })
    // Release the connection; we never read the reply.
    await res.body?.cancel()
  } catch (err) {
    console.error('[review-telemetry] dropped events:', err instanceof Error ? err.name : 'unknown')
  }
}
