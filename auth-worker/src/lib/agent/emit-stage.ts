// Staging pipeline for the agent's `emit` calls (implementation plan
// §"Server internals" — emit-stage.ts).
//
// Nothing here writes to the database. Each requested event is:
//   1. role-checked against AGENT_REQUIRED_ROLE (same table the prompt
//      filter uses — the server re-validates even though the prompt already
//      filtered),
//   2. alias/:var resolved (#c1/#e1/#f1 + :file/:cell from compress.ts),
//   3. chain-resolved: parentId = the cell's current target head
//      (cells.event_id) and sourceEventId = the source row's head, fetched
//      via SQL at stage time,
//   4. staleness pre-checked: a model-supplied parentId that no longer
//      matches the head is reported `stale` instead of staged,
//   5. provenance-injected: ai_suggestion:true + agent_run_id on
//      target.cell.commit payloads,
//   6. given display context {canonicalRef, before, after} for the client's
//      proposal card.
//
// The client applies a proposal by building real events (its own UUIDv7 ids,
// author = the current user) and pushing them through the SAME outbox /
// POST /events path normal edits use — the sync pipeline stays the only
// writer.

import { AliasMap } from "./compress"
import { AGENT_REQUIRED_ROLE, ROLE_NAME } from "./schema-card"
import { loadLintRules, lintDraft } from "./lint"

// ── Wire contract (must match the plan doc byte-for-byte) ───────────────────

export interface AgentProposal {
  proposalId: string
  runId: string
  events: StagedEvent[]
  summary: string
}

export interface StagedEvent {
  kind: string
  fileId?: string
  cellId?: string
  parentId?: string
  payload: Record<string, unknown>
  display: { canonicalRef?: string; before?: string; after?: string }
}

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface EmitStageContext {
  runId: string
  projectId: string
  roleLevel: number
  /** Focused file/cell for :file / :cell resolution. */
  fileId?: string
  cellId?: string
  aliases: AliasMap
}

interface RawEmitEvent {
  kind?: unknown
  fileId?: unknown
  cellId?: unknown
  parentId?: unknown
  payload?: unknown
}

export interface EmitStageResult {
  /** Null when nothing staged (all events rejected/stale). */
  proposal: AgentProposal | null
  /** Compact verdict block fed back to the model as the tool result. */
  modelVerdictBlock: string
}

// Kinds whose payload writes the target chain → need parent/source resolution.
const TARGET_CHAIN_KINDS = new Set(["target.cell.commit"])

/** Resolve ':file' / ':cell' / '#c1'-style references in an id-ish string. */
function resolveRef(
  value: string,
  ctx: EmitStageContext,
): { ok: true; value: string } | { ok: false; error: string } {
  if (value === ":file") {
    if (!ctx.fileId) return { ok: false, error: ":file is not bound (no focused file)" }
    return { ok: true, value: ctx.fileId }
  }
  if (value === ":cell") {
    if (!ctx.cellId) return { ok: false, error: ":cell is not bound (no focused cell)" }
    return { ok: true, value: ctx.cellId }
  }
  if (value === ":project") return { ok: true, value: ctx.projectId }
  if (AliasMap.isAlias(value)) {
    const id = ctx.aliases.resolve(value)
    if (!id) return { ok: false, error: `unknown alias ${value}` }
    return { ok: true, value: id }
  }
  return { ok: true, value }
}

/** Resolve refs in every string value of a payload (one level deep is enough
 *  for the event payload shapes — ids never nest deeper). */
function resolvePayloadRefs(
  payload: Record<string, unknown>,
  ctx: EmitStageContext,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" && (value.startsWith(":") || AliasMap.isAlias(value))) {
      const r = resolveRef(value, ctx)
      if (!r.ok) return r
      out[key] = r.value
    } else {
      out[key] = value
    }
  }
  return { ok: true, payload: out }
}

interface CellRow {
  side: string
  event_id: string
  value: string
  canonical_ref: string | null
}

async function fetchCellPair(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  cellId: string,
): Promise<{ source: CellRow | null; target: CellRow | null }> {
  const { results } = await db
    .prepare(
      `SELECT side, event_id, value, canonical_ref FROM cells
       WHERE project_id = ? AND file_id = ? AND cell_id = ?`,
    )
    .bind(projectId, fileId, cellId)
    .all<CellRow>()
  return {
    source: results.find((r) => r.side === "source") ?? null,
    target: results.find((r) => r.side === "target") ?? null,
  }
}

type Verdict =
  | { kind: "staged"; event: StagedEvent; sourceValue?: string }
  | { kind: "rejected"; reason: string }
  | { kind: "stale"; reason: string }

async function stageOne(
  db: AquillaDb,
  raw: RawEmitEvent,
  ctx: EmitStageContext,
): Promise<Verdict> {
  if (typeof raw !== "object" || raw === null || typeof raw.kind !== "string") {
    return { kind: "rejected", reason: "each event needs a string `kind`" }
  }
  const kind = raw.kind

  // 1. Known kind + role floor (server-side re-validation of the prompt filter).
  const floor = AGENT_REQUIRED_ROLE[kind]
  if (floor === undefined) {
    return { kind: "rejected", reason: `unknown event kind "${kind}"` }
  }
  if (ctx.roleLevel < floor) {
    return {
      kind: "rejected",
      reason: `role too low: ${kind} requires ${ROLE_NAME[floor] ?? floor} (${floor}), you act as ${ROLE_NAME[ctx.roleLevel] ?? ctx.roleLevel} (${ctx.roleLevel})`,
    }
  }

  // 2. Resolve aliases/:vars on the envelope ids.
  let fileId: string | undefined
  let cellId: string | undefined
  let suppliedParentId: string | undefined
  for (const [field, value] of [
    ["fileId", raw.fileId],
    ["cellId", raw.cellId],
    ["parentId", raw.parentId],
  ] as const) {
    if (value === undefined || value === null) continue
    if (typeof value !== "string") return { kind: "rejected", reason: `${field} must be a string` }
    const r = resolveRef(value, ctx)
    if (!r.ok) return { kind: "rejected", reason: `${field}: ${r.error}` }
    if (field === "fileId") fileId = r.value
    else if (field === "cellId") cellId = r.value
    else suppliedParentId = r.value
  }

  const rawPayload =
    raw.payload && typeof raw.payload === "object" ? (raw.payload as Record<string, unknown>) : {}
  const resolved = resolvePayloadRefs(rawPayload, ctx)
  if (!resolved.ok) return { kind: "rejected", reason: `payload: ${resolved.error}` }
  const payload = resolved.payload

  const display: StagedEvent["display"] = {}
  let parentId: string | undefined

  // Source text of the paired cell — carried out for draft lint.
  let sourceValue: string | undefined

  // 3–5. Cell-anchored kinds: fetch the live pair for chain + display context.
  const needsCell =
    kind.startsWith("target.cell.") || kind.startsWith("source.cell.") ||
    kind.startsWith("cell.")
  if (needsCell || kind === "comment.create") {
    if (needsCell && (!fileId || !cellId)) {
      return { kind: "rejected", reason: `${kind} needs fileId and cellId` }
    }
    if (fileId && cellId) {
      const pair = await fetchCellPair(db, ctx.projectId, fileId, cellId)
      display.canonicalRef =
        pair.target?.canonical_ref ?? pair.source?.canonical_ref ?? undefined

      if (TARGET_CHAIN_KINDS.has(kind)) {
        if (!pair.target && !pair.source) {
          return {
            kind: "rejected",
            reason: "no cell exists at that id — re-read the file",
          }
        }
        // First translation of an existing source cell is a genesis commit
        // (parentId null) — the same shape the editor emits when a user types
        // into an empty target. Only a known target head becomes the parent.
        if (pair.target) {
          // Staleness pre-check: a parent the model pinned that is no longer
          // the head means it drafted against superseded text.
          if (suppliedParentId && suppliedParentId !== pair.target.event_id) {
            return {
              kind: "stale",
              reason: `parent superseded — current head is ${ctx.aliases.alias(pair.target.event_id, "e")}; re-read the cell and redraft`,
            }
          }
          parentId = pair.target.event_id
        }
        display.before = pair.target?.value ?? ""
        if (typeof payload.value !== "string") {
          return { kind: "rejected", reason: "target.cell.commit payload needs a string `value`" }
        }
        display.after = payload.value
        // Provenance injection (AQU-292): machine-drafted, attributable to the run.
        payload.ai_suggestion = true
        payload.agent_run_id = ctx.runId
        payload.sourceEventId = pair.source?.event_id ?? null
        sourceValue = pair.source?.value
      } else if (kind === "cell.validate") {
        if (!pair.target) {
          return { kind: "rejected", reason: "no target cell exists to validate" }
        }
        if (typeof payload.editEventId !== "string") {
          payload.editEventId = pair.target.event_id
        } else if (payload.editEventId !== pair.target.event_id) {
          return {
            kind: "stale",
            reason: `editEventId is not the current head (${ctx.aliases.alias(pair.target.event_id, "e")}) — the cell changed since you read it`,
          }
        }
        display.before = pair.target.value
      } else {
        display.before = pair.target?.value ?? pair.source?.value
      }
    }
  }

  if (kind === "comment.create") {
    if (typeof payload.body !== "string" || payload.body.length === 0) {
      return { kind: "rejected", reason: "comment.create payload needs a non-empty `body`" }
    }
    if (typeof payload.commentId !== "string") payload.commentId = crypto.randomUUID()
    if (payload.parentCommentId === undefined) payload.parentCommentId = null
    if (payload.scope === undefined) {
      payload.scope =
        fileId && cellId
          ? { kind: "cell", fileId, cellId }
          : fileId
            ? { kind: "file", fileId }
            : { kind: "project" }
    }
    display.after = payload.body as string
  }

  const event: StagedEvent = { kind, payload, display }
  if (fileId) event.fileId = fileId
  if (cellId) event.cellId = cellId
  if (parentId) event.parentId = parentId
  return { kind: "staged", event, sourceValue }
}

function summarize(events: StagedEvent[]): string {
  const byKind = new Map<string, StagedEvent[]>()
  for (const e of events) {
    const list = byKind.get(e.kind) ?? []
    list.push(e)
    byKind.set(e.kind, list)
  }
  const parts: string[] = []
  for (const [kind, list] of byKind) {
    const refs = list.map((e) => e.display.canonicalRef).filter(Boolean) as string[]
    const span =
      refs.length === 0 ? "" : refs.length === 1 ? ` (${refs[0]})` : ` (${refs[0]} – ${refs[refs.length - 1]})`
    parts.push(`${list.length}× ${kind}${span}`)
  }
  return `Stage ${events.length} event${events.length === 1 ? "" : "s"}: ${parts.join(", ")}`
}

/**
 * Stage a batch of model-requested events. Returns the proposal for the SSE
 * `proposal` frame plus the verdict block the model sees as its tool result.
 */
export async function stageEvents(
  db: AquillaDb,
  rawEvents: unknown[],
  ctx: EmitStageContext,
): Promise<EmitStageResult> {
  const staged: StagedEvent[] = []
  const lines: string[] = ["i|kind|ref|verdict"]

  // Deterministic lint on staged drafts: load the project's enabled rules once
  // per emit so the MODEL sees violations and can redraft before the user does.
  const anyCommit = rawEvents.some(
    (r) => (r as RawEmitEvent)?.kind === "target.cell.commit",
  )
  const lintRules = anyCommit ? await loadLintRules(db, ctx.projectId) : []
  const lintLines: string[] = []

  for (let i = 0; i < rawEvents.length; i++) {
    const raw = rawEvents[i] as RawEmitEvent
    const kind = typeof raw?.kind === "string" ? raw.kind : "?"
    let verdict: Verdict
    try {
      verdict = await stageOne(db, raw, ctx)
    } catch (err) {
      verdict = { kind: "rejected", reason: `stage error: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (verdict.kind === "staged") {
      staged.push(verdict.event)
      lines.push(`${i + 1}|${kind}|${verdict.event.display.canonicalRef ?? "∅"}|staged`)
      if (kind === "target.cell.commit" && lintRules.length > 0) {
        const hits = lintDraft(
          lintRules,
          verdict.sourceValue ?? "",
          typeof verdict.event.payload.value === "string" ? verdict.event.payload.value : "",
        )
        for (const h of hits) {
          lintLines.push(
            `NEEDS REVIEW ${verdict.event.display.canonicalRef ?? `#${i + 1}`}: rule "${h.ruleName}" — ${h.message}`,
          )
        }
      }
    } else {
      lines.push(`${i + 1}|${kind}|∅|${verdict.kind}: ${verdict.reason}`)
    }
  }

  if (lintLines.length > 0) {
    lines.push(
      ...lintLines,
      "Fix the NEEDS REVIEW drafts and re-emit them (same cellIds) — the corrected versions replace these in the proposal.",
    )
  }

  lines.push(
    staged.length > 0
      ? `${staged.length} of ${rawEvents.length} staged — shown to the user for approval; NOT yet written.`
      : `0 of ${rawEvents.length} staged — nothing proposed.`,
  )

  const proposal: AgentProposal | null =
    staged.length > 0
      ? {
          proposalId: crypto.randomUUID(),
          runId: ctx.runId,
          events: staged,
          summary: summarize(staged),
        }
      : null

  return { proposal, modelVerdictBlock: lines.join("\n") }
}
