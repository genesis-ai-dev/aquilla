import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Context } from "hono"
import type { Env, Variables } from "../types"
import { authMiddleware } from "../middleware/auth"
import { resolveProjectRole } from "../services/project-permissions"
import { resolveProjectRoleShared } from "../../../db/shared/project-roles"
import { secureCompare } from "../utils/secure-compare"
import { ASR_MODEL_CHOICES } from "../../../db/shared/asr-models"
import { omniWarmCostCents, type OmniModel } from "../../../db/shared/omni-asr-cost"
import { admitPaidCall } from "../lib/billing/paid-call"
import { releaseChatUsage } from "../lib/billing/chat-usage"
import { settleWorkspaceUsage } from "../lib/billing/workspace-usage"
import { COMPRESSED_AUDIO_FORMATS, transcribe, type TranscribeResult } from "../lib/transcribe-core"
import { omniConfigured, omniFetch, omniStatusSchema, zeroShotEnabledForOrg } from "../lib/omni-asr"

const transcription = new Hono<{ Bindings: Env; Variables: Variables }>()

/** Contributor: the role that may record and transcribe. */
const TRANSCRIBE_MIN_ROLE = 400

const base64Audio = z.string().min(1).max(2600000).regex(/^[A-Za-z0-9+/]+={0,2}$/)
const commonFields = {
  projectId: z.string().min(1).max(200),
  /** The project's raw BCP-47 tag; the server picks the model from it. */
  language: z.string().max(64).regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/).optional(),
  /** "auto" routes by language (spec §1); the rest are explicit picks. */
  model: z.enum(ASR_MODEL_CHOICES).default("auto"),
  /** Zero-shot context pairs from GET …/transcription-examples. */
  examples: z.array(z.object({
    url: z.string().max(4096),
    text: z.string().min(1).max(4000),
  })).max(10).optional(),
}
const requestSchema = z.object({
  ...commonFields,
  input_audio: z.object({ data: base64Audio, format: z.literal("wav") }),
})

type AppContext = Context<{ Bindings: Env; Variables: Variables }>
function respond(c: AppContext, result: TranscribeResult, extra?: (body: object) => object) {
  if (!result.ok) return c.json(result.body, result.status, result.headers)
  return c.json(extra ? extra(result.body) : result.body, 200, result.headers)
}

transcription.post("/transcriptions", authMiddleware,
  bodyLimit({ maxSize: 2700000 }),
  zValidator("json", requestSchema), async c => {
    const user = c.get("user")
    const request = c.req.valid("json")
    const role = await resolveProjectRole(c.env, user, request.projectId)
    if (!role || role.level < TRANSCRIBE_MIN_ROLE) return c.json({ error: "forbidden" }, 403)
    return respond(c, await transcribe(c.env, {
      userId: user.id, projectId: request.projectId, audio: request.input_audio,
      language: request.language, model: request.model, examples: request.examples,
      idempotencyKey: c.req.header("Idempotency-Key"), requestUrl: c.req.url,
    }))
  })

// ── Internal: sync-worker's Agent API tools (spec §7) ─────────────────────
// Authenticated with the shared SYNC_SECRET_KEY like ai-draft-internal.ts;
// the user's role is resolved live here, never trusted from the caller.
// A stored take is forwarded in its own container (webm/ogg/…), with the
// duration from its row.

function internalCaller(c: AppContext) {
  const header = c.req.header("Authorization") ?? ""
  return Boolean(c.env.SYNC_SECRET_KEY) && secureCompare(header, `Bearer ${c.env.SYNC_SECRET_KEY}`)
}
const internalUser = z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)])

const internalRequestSchema = z.object({
  ...commonFields,
  userId: internalUser,
  requestId: z.string().uuid().optional(),
  audio: z.object({
    data: base64Audio,
    format: z.enum(["wav", ...COMPRESSED_AUDIO_FORMATS]),
    durationMs: z.number().int().positive().max(60000).optional(),
  }),
})

transcription.post("/internal/transcriptions",
  bodyLimit({ maxSize: 2700000 }),
  zValidator("json", internalRequestSchema), async c => {
    if (!internalCaller(c)) return c.json({ error: "unauthorized" }, 401)
    const body = c.req.valid("json")
    const role = await resolveProjectRoleShared(c.env.AQUILLA_PG, { id: String(body.userId) }, body.projectId)
    if (!role || role.level < TRANSCRIBE_MIN_ROLE) return c.json({ error: "permission_denied" }, 403)
    const result = await transcribe(c.env, {
      userId: body.userId, projectId: body.projectId, audio: body.audio,
      language: body.language, model: body.model, examples: body.examples,
      idempotencyKey: body.requestId, requestUrl: c.req.url,
    })
    const creditsCharged = result.ok ? result.creditsCharged : null
    return respond(c, result, ok => ({ ...ok, creditsCharged }))
  })

// ── Warm-up + status proxies (spec §5). Only a project contributor can warm,
// and ZS respects the org gate so a disabled org cannot spin up the expensive
// container. A warm-up spends GPU time, so it passes the one entitlement check
// on the gpu rail like a transcription (AQU-2062, spec Q3): no unmetered path
// a user can loop on.

/** Accept our model ids and Modal's short names alike. */
const omniModelParam = z.enum(["ctc", "zs", "omni-ctc", "omni-zs"])
  .transform((m): OmniModel => (m === "omni-ctc" || m === "ctc" ? "ctc" : "zs"))

async function omniGate(env: Env, projectId: string, model: OmniModel): Promise<{ error: string; status: 403 | 503 } | null> {
  if (!omniConfigured(env)) return { error: "Omnilingual transcription is not configured", status: 503 }
  if (model === "zs") {
    const project = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
      .bind(projectId).first<{ org_id: number | null }>()
    let enabled: boolean
    try { enabled = await zeroShotEnabledForOrg(env.AQUILLA_PG, project?.org_id ?? 0) }
    catch { return { error: "Transcription settings unavailable", status: 503 } }
    if (!enabled) return { error: "zero_shot_disabled", status: 403 }
  }
  return null
}

async function warm(c: AppContext, projectId: string, model: OmniModel, userId: number) {
  const denied = await omniGate(c.env, projectId, model)
  if (denied) return c.json({ error: denied.error }, denied.status)
  if (!omniConfigured(c.env)) return c.json({ error: "Omnilingual transcription is not configured" }, 503)
  const project = await c.env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
    .bind(projectId).first<{ org_id: number | null }>()
  const cost = omniWarmCostCents(model)
  const gate = await admitPaidCall(c.env, {
    orgId: project?.org_id ?? 0, userId, projectId, rail: "gpu", provider: "modal",
    houseKey: c.env.OMNI_SHARED_SECRET, requestUrl: c.req.url, estimate: () => cost,
  })
  if (!gate.ok) return c.json(gate.body, gate.status)
  try {
    const { response, backend } = await omniFetch(c.env, "/warm", { method: "POST", body: { model }, timeoutMs: 10000 })
    if (backend === "primary" && response.ok) {
      // The self-hosted models are always loaded: this warm-up started no GPU.
      if (gate.usage) await releaseChatUsage(c.env, gate.usage)
      return c.json({ ok: true }, 202)
    }
    if (!response.ok) {
      // As for /transcribe: a 4xx other than 408 is refused before any GPU
      // starts, so it is proven free. Anything less certain stays held.
      if (gate.usage && response.status >= 400 && response.status < 500 && response.status !== 408) {
        await releaseChatUsage(c.env, gate.usage)
      }
      return c.json({ error: "Warm-up failed" }, 502)
    }
  } catch { return c.json({ error: "Warm-up unavailable" }, 502) }
  if (gate.usage) {
    try { await settleWorkspaceUsage(c.env.AQUILLA_PG, gate.usage.orgId, gate.usage.requestId, cost) }
    catch { console.warn("[billing] omnilingual warm-up usage requires reconciliation", gate.usage) }
  }
  return c.json({ ok: true }, 202)
}

async function status(c: AppContext, projectId: string, model: OmniModel) {
  const denied = await omniGate(c.env, projectId, model)
  if (denied) return c.json({ error: denied.error }, denied.status)
  if (!omniConfigured(c.env)) return c.json({ error: "Omnilingual transcription is not configured" }, 503)
  try {
    const { response } = await omniFetch(c.env, `/status?model=${model}`, { method: "GET", timeoutMs: 10000 })
    if (!response.ok) return c.json({ error: "Status unavailable" }, 502)
    const parsed = omniStatusSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "Invalid status response" }, 502)
    return c.json(parsed.data, 200, { "Cache-Control": "no-store" })
  } catch { return c.json({ error: "Status unavailable" }, 502) }
}

const warmSchema = z.object({ projectId: z.string().min(1).max(200), model: omniModelParam })
const statusQuerySchema = z.object({ projectId: z.string().min(1).max(200), model: omniModelParam.default("zs") })

async function memberMay(c: AppContext, projectId: string) {
  const role = await resolveProjectRole(c.env, c.get("user"), projectId)
  return Boolean(role && role.level >= TRANSCRIBE_MIN_ROLE)
}

transcription.post("/transcriptions/warm", authMiddleware,
  zValidator("json", warmSchema), async c => {
    const { projectId, model } = c.req.valid("json")
    if (!(await memberMay(c, projectId))) return c.json({ error: "forbidden" }, 403)
    return warm(c, projectId, model, c.get("user").id)
  })

transcription.get("/transcriptions/status", authMiddleware,
  zValidator("query", statusQuerySchema), async c => {
    const { projectId, model } = c.req.valid("query")
    if (!(await memberMay(c, projectId))) return c.json({ error: "forbidden" }, 403)
    return status(c, projectId, model)
  })

const internalWarmSchema = z.object({
  projectId: z.string().min(1).max(200), userId: internalUser, model: omniModelParam,
  action: z.enum(["status", "warm"]).default("status"),
})

transcription.post("/internal/transcriptions/status",
  zValidator("json", internalWarmSchema), async c => {
    if (!internalCaller(c)) return c.json({ error: "unauthorized" }, 401)
    const { projectId, userId, model, action } = c.req.valid("json")
    const role = await resolveProjectRoleShared(c.env.AQUILLA_PG, { id: String(userId) }, projectId)
    if (!role || role.level < TRANSCRIBE_MIN_ROLE) return c.json({ error: "permission_denied" }, 403)
    if (action === "warm") {
      const warmed = await warm(c, projectId, model, userId)
      if (warmed.status !== 202) return warmed
    }
    return status(c, projectId, model)
  })

export default transcription
