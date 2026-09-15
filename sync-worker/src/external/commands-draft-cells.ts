// DraftCells (AQU-1186, parity epic AQU-1181 item 7) — invoke the PROJECT'S
// OWN copilot over named cells and stage the results as one changeset.
//
// Why it exists: until now an agent could only write text it wrote itself.
// DraftCells lets it ask the app to draft, so the output carries the project's
// terminology, few-shot pairs and brief — and lands as `ai_drafted`, exactly
// like an in-app draft, so a human reviews it as AI work rather than as a
// human edit.
//
// Shape: the command is a PREPARE-TIME EXPANSION. Drafting happens once, here,
// at prepare; the generated text is materialized into ordinary SetTranslation
// commands carrying server-minted `aiDraft` provenance, so the whole existing
// changeset pipeline (preconditions, digest, approval gate, commit, provenance
// stamping, crash-retry id ledger) applies unchanged. There is no second
// drafting call at commit — the human approves text they can actually read.
//
// Cost rails (issue spec, not suggestion):
//   - cellIds are EXPLICIT and non-empty; wildcards are rejected outright.
//   - The per-changeset cap is the project's configured completion batch size
//     (AQU-586's `completionBatchSizeFor`, same clamp) — see
//     db/shared/completion-batch.ts. Over-cap requests name the cap.
//   - The model call, the AI budget guard and the credit ledger all live in
//     auth-worker (it owns the OpenRouter key); credit exhaustion comes back as
//     a clean named error and NOTHING is staged.

import { ROLE } from '../events/role-policy'
import type { AiDraftProvenance } from '../events/types'
import { ExternalError } from './errors'
import type { CommandValidationIssue } from './commands'

/** Draft named cells with the project's copilot; stages as AI drafts. */
export interface DraftCellsCommand {
  kind: 'DraftCells'
  fileId: string
  /** Explicit cell ids — never a wildcard, never "everything". */
  cellIds: string[]
  /** Target-language lane (AQU-538); omit for the default lane. */
  laneId?: string
  /** Optional extra steer passed through to the drafting prompt. */
  instructions?: string
}

/** Hard ceiling on `instructions`, so a command cannot smuggle a prompt. */
const MAX_INSTRUCTIONS = 2000

/** Rejected outright rather than silently expanded — "draft everything" is
 *  precisely the unbounded-spend shape the cost rails exist to prevent. */
const WILDCARDS = new Set(['*', '**', 'all', '%'])

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Validate a raw DraftCells command. Cap enforcement is NOT here — the cap is
 *  per-project and needs a DB read, so prepare enforces it (see
 *  `assertWithinBatchCap`). */
export function validateDraftCellsCommand(
  c: Record<string, unknown>,
  index: number,
  issues: CommandValidationIssue[],
): DraftCellsCommand | null {
  if (!isNonEmptyString(c.fileId)) {
    issues.push({ index, message: 'DraftCells.fileId must be a non-empty string' })
    return null
  }
  if (!Array.isArray(c.cellIds) || c.cellIds.length === 0) {
    issues.push({ index, message: 'DraftCells.cellIds must be a non-empty array of cell ids' })
    return null
  }
  const cellIds: string[] = []
  for (const [i, raw] of c.cellIds.entries()) {
    if (!isNonEmptyString(raw)) {
      issues.push({ index, message: `DraftCells.cellIds[${i}] must be a non-empty string` })
      return null
    }
    if (WILDCARDS.has(raw.trim().toLowerCase())) {
      issues.push({
        index,
        message:
          `DraftCells.cellIds[${i}] is a wildcard — DraftCells takes explicit cell ids only. ` +
          'List the cells you want drafted (read them first with the cells endpoint).',
      })
      return null
    }
    if (!cellIds.includes(raw)) cellIds.push(raw)
  }
  if (c.laneId !== undefined && (!isNonEmptyString(c.laneId) || c.laneId.length > 64)) {
    issues.push({
      index,
      message: 'DraftCells.laneId must be a non-empty string (max 64 chars) when present — omit it for the default lane',
    })
    return null
  }
  if (c.instructions !== undefined) {
    if (typeof c.instructions !== 'string' || c.instructions.length > MAX_INSTRUCTIONS) {
      issues.push({
        index,
        message: `DraftCells.instructions must be a string of at most ${MAX_INSTRUCTIONS} characters when present`,
      })
      return null
    }
  }
  return {
    kind: 'DraftCells',
    fileId: c.fileId,
    cellIds,
    ...(c.laneId !== undefined ? { laneId: c.laneId as string } : {}),
    ...(c.instructions !== undefined ? { instructions: c.instructions as string } : {}),
  }
}

/** Static index-filtering floor: DraftCells compiles to target.cell.commit. */
export function draftCellsFloor(): number {
  return ROLE.CONTRIBUTOR
}

/** Throw the canonical over-cap error, naming the cap (the agent needs the
 *  number to split the work, not just a refusal). */
export function assertWithinBatchCap(cmd: DraftCellsCommand, cap: number): void {
  if (cmd.cellIds.length > cap) {
    throw new ExternalError(
      'validation_failed',
      `DraftCells requests ${cmd.cellIds.length} cells but this project's completion batch size is ${cap} — ` +
        'split the work across changesets of at most that many cells',
      { requested: cmd.cellIds.length, maxCells: cap },
    )
  }
}

// ── auth-worker drafting bridge ──────────────────────────────────────────────

/** One drafted cell as auth-worker returns it. */
export interface GeneratedDraft {
  cellId: string
  value: string
  aiDraft?: AiDraftProvenance
}

/** The bridge's response is server-authored, but it still crosses a network
 *  boundary — shape-check the provenance rather than casting it onto an event
 *  payload. A malformed record simply drops (the draft still stages, it just
 *  carries no provenance) instead of poisoning the projection. */
function toProvenance(v: unknown): AiDraftProvenance | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const p = v as Record<string, unknown>
  const state = p.projectState
  if (
    typeof p.model !== 'string' ||
    typeof p.provider !== 'string' ||
    typeof p.promptVersion !== 'string' ||
    typeof p.generatedAt !== 'number' ||
    !Array.isArray(p.exampleIds) ||
    !state ||
    typeof state !== 'object'
  ) {
    return undefined
  }
  return v as AiDraftProvenance
}

export interface DraftBridgeEnv {
  AUTH_WORKER_URL?: string
  SYNC_SECRET_KEY?: string
}

interface DraftBridgeResponse {
  fileId?: string
  model?: string
  drafts?: { cellId?: unknown; value?: unknown; aiDraft?: unknown }[]
  missed?: string[]
  remaining?: number
}

/**
 * Ask auth-worker's drafting pipeline for the text. Every failure maps to a
 * NAMED external error so the agent can branch: a credit cap is
 * `rate_limited` (retryable once the org tops up), a role/permission problem is
 * `permission_denied`, anything else is `job_failed`. Nothing is staged on any
 * of these paths — the caller throws before it reaches stageAndRespond.
 */
export async function requestDrafts(
  env: DraftBridgeEnv,
  input: {
    projectId: string
    userId: string | number
    fileId: string
    cellIds: string[]
    instructions?: string
  },
): Promise<{ drafts: GeneratedDraft[]; missed: string[] }> {
  if (!env.AUTH_WORKER_URL || !env.SYNC_SECRET_KEY) {
    throw new ExternalError('job_failed', 'drafting backend is not configured in this environment')
  }

  let res: Response
  try {
    res = await fetch(`${env.AUTH_WORKER_URL}/api/v1/ai/agent/internal/draft-cells`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    })
  } catch {
    throw new ExternalError('job_failed', 'drafting backend unreachable — nothing was staged')
  }

  if (!res.ok) {
    let body: { error?: string; message?: string; reason?: string; cap?: number } = {}
    try {
      body = (await res.json()) as typeof body
    } catch {
      /* non-JSON upstream error — fall through to the generic message */
    }
    if (body.error === 'credit_cap_exceeded') {
      throw new ExternalError(
        'rate_limited',
        `credit cap reached on the agent rail (${body.reason ?? 'cap'}) — no cells were drafted and nothing was staged`,
        { reason: body.reason ?? null },
      )
    }
    if (res.status === 403) {
      throw new ExternalError('permission_denied', body.message ?? 'drafting is not permitted for this credential')
    }
    if (res.status === 429) {
      throw new ExternalError('rate_limited', body.message ?? 'drafting budget exhausted — nothing was staged')
    }
    if (res.status === 400) {
      throw new ExternalError('validation_failed', body.message ?? 'drafting rejected the request', body)
    }
    throw new ExternalError('job_failed', body.message ?? 'drafting failed — nothing was staged')
  }

  let body: DraftBridgeResponse
  try {
    body = (await res.json()) as DraftBridgeResponse
  } catch {
    throw new ExternalError('job_failed', 'drafting backend returned an unreadable response')
  }
  const drafts: GeneratedDraft[] = []
  for (const d of body.drafts ?? []) {
    if (!isNonEmptyString(d?.cellId)) continue
    if (typeof d.value !== 'string' || d.value.trim() === '') continue
    const provenance = toProvenance(d.aiDraft)
    drafts.push({
      cellId: d.cellId,
      value: d.value,
      ...(provenance ? { aiDraft: provenance } : {}),
    })
  }
  return { drafts, missed: body.missed ?? [] }
}
