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
import { cellEditingFloorFromSettings, isCellEditingKind } from "../../../../db/shared/cell-editing-floor"

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
  /** AQU-846: fileName is what the approval UI names, so the user can see
   *  WHICH file a proposed cell lands in before they click Apply. */
  display: { canonicalRef?: string; fileName?: string; before?: string; after?: string }
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/**
 * AQU-1670: what one staging call did, in counts and milliseconds.
 *
 * The 522s that motivated this surfaced only as generic handled `$exception`s
 * from the SPA bundle, so there was no way to see that staging duration
 * tracked cell count — the one fact that would have named the cause. This is
 * the explicit signal. Counts and timings only: nothing a user or the model
 * wrote is in here.
 */
export interface StageOutcome {
  runId: string
  projectId: string
  /** Events the model asked to stage. */
  requested: number
  staged: number
  rejected: number
  stale: number
  /** Wall-clock duration of the whole staging call. */
  durationMs: number
  /** Distinct cells the batched prefetch covered. */
  cellsPrefetched: number
  /** Per-cell reads the prefetch did not cover. Zero on the normal path — a
   *  non-zero value is the regression this issue existed to remove. */
  fallbackQueries: number
  status: "staged" | "nothing_staged" | "prefetch_failed"
}

export type StageOutcomeSink = (outcome: StageOutcome) => void

export interface EmitStageContext {
  runId: string
  projectId: string
  roleLevel: number
  /** Focused file/cell for :file / :cell resolution. */
  fileId?: string
  cellId?: string
  /** Active lane ('' = default lane). Required for proper lane scoping. */
  lane: string
  aliases: AliasMap
  /** AQU-1670: optional telemetry sink for the stage-outcome event. Never
   *  awaited and never load-bearing — a throwing sink cannot fail a batch. */
  onStageOutcome?: StageOutcomeSink
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

// AQU-890: genesis kinds — they mint a row instead of advancing a chain, so
// they take the opposite staging path (no parent, no `before`, id must be free).
const CELL_CREATE_KINDS = new Set(["source.cell.create", "target.cell.create"])

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

/** The live source/target rows for one cell, as seen from the run's lane. */
interface CellPair {
  source: CellRow | null
  target: CellRow | null
}

function pairKey(fileId: string, cellId: string): string {
  return `${fileId}\u0000${cellId}`
}

/** Split one cell's rows by side. AQU-1447: the target row is the ACTIVE
 *  lane's, never another lane's head; source rows always live at
 *  target_lang = '' (see selectCellPairs). Both SQL shapes below already
 *  filter to those two rows, so this only has to pick them apart. */
function splitPair(rows: readonly CellRow[]): CellPair {
  return {
    source: rows.find((r) => r.side === "source") ?? null,
    target: rows.find((r) => r.side === "target") ?? null,
  }
}

async function fetchCellPair(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  cellId: string,
  lane: string,
): Promise<CellPair> {
  const { results } = await db
    .prepare(
      `SELECT side, event_id, value, canonical_ref FROM cells
       WHERE project_id = ? AND file_id = ? AND cell_id = ?
         AND ((side = 'source' AND target_lang = '') OR (side = 'target' AND target_lang = ?))`,
    )
    .bind(projectId, fileId, cellId, lane)
    .all<CellRow>()
  return splitPair(results ?? [])
}

// ── Batched cell reads (AQU-1670) ───────────────────────────────────────────
//
// `stageOne` used to issue its own `fetchCellPair` round-trip per event, so a
// 28-cell proposal cost 28 SEQUENTIAL Hyperdrive→Neon round-trips and a
// 100-cell one cost 100. Staging duration therefore scaled with cell count,
// and a whole-file proposal ran past Cloudflare's origin timeout (522) —
// discarding every cell the model had just paid to draft, with retries
// failing identically because the cost was structural rather than transient.
//
// The reads are independent and lane-uniform, so they collapse into ONE
// statement for the whole batch: the same shape sync-worker's
// `resolveCellStates` already uses for the external changeset path. Staging is
// now flat in cell count instead of linear in it.

/** Cells per prefetch statement. The 28-cell repro and the 100-cell
 *  acceptance case are each a single query; a pathological batch chunks rather
 *  than building a statement with tens of thousands of placeholders. */
const PREFETCH_CHUNK = 250

/** Transient-failure budget for the prefetch. The whole batch now rides on
 *  this one read, so a single hiccup must not discard a proposal the model
 *  already paid to produce — retry it before giving up (AQU-1670). */
const PREFETCH_ATTEMPTS = 3
const PREFETCH_BACKOFF_MS = [100, 300]

async function fetchCellPairChunk(
  db: AquillaDb,
  projectId: string,
  lane: string,
  cells: readonly { fileId: string; cellId: string }[],
): Promise<Map<string, CellPair>> {
  const placeholders = cells.map(() => "(?, ?)").join(", ")
  const binds: unknown[] = [projectId, lane]
  for (const c of cells) binds.push(c.fileId, c.cellId)

  const { results } = await db
    .prepare(
      `SELECT file_id, cell_id, side, event_id, value, canonical_ref FROM cells
       WHERE project_id = ?
         AND ((side = 'source' AND target_lang = '') OR (side = 'target' AND target_lang = ?))
         AND (file_id, cell_id) IN (${placeholders})`,
    )
    .bind(...binds)
    .all<CellRow & { file_id: string; cell_id: string }>()

  const rowsByCell = new Map<string, CellRow[]>()
  for (const row of results ?? []) {
    const key = pairKey(row.file_id, row.cell_id)
    const list = rowsByCell.get(key)
    if (list) list.push(row)
    else rowsByCell.set(key, [row])
  }

  // Every REQUESTED cell gets an entry, present in the projection or not:
  // "prefetched and absent" must be distinguishable from "never prefetched",
  // or a cell that genuinely does not exist (the common `target.cell.create`
  // collision check) would fall back to its own query every time.
  const pairs = new Map<string, CellPair>()
  for (const c of cells) {
    const key = pairKey(c.fileId, c.cellId)
    pairs.set(key, splitPair(rowsByCell.get(key) ?? []))
  }
  return pairs
}

/** One batched read for every cell the batch names, with a bounded retry.
 *  `failed` means the read could not be made at all; the reader below then
 *  degrades to per-cell queries rather than failing the batch outright. */
async function prefetchCellPairs(
  db: AquillaDb,
  projectId: string,
  lane: string,
  cells: readonly { fileId: string; cellId: string }[],
): Promise<{ pairs: Map<string, CellPair>; failed: boolean }> {
  const pairs = new Map<string, CellPair>()
  if (cells.length === 0) return { pairs, failed: false }

  for (let i = 0; i < cells.length; i += PREFETCH_CHUNK) {
    const chunk = cells.slice(i, i + PREFETCH_CHUNK)
    let lastErr: unknown
    let ok = false
    for (let attempt = 0; attempt < PREFETCH_ATTEMPTS; attempt++) {
      try {
        for (const [key, pair] of await fetchCellPairChunk(db, projectId, lane, chunk)) {
          pairs.set(key, pair)
        }
        ok = true
        break
      } catch (err) {
        lastErr = err
        const wait = PREFETCH_BACKOFF_MS[attempt]
        if (wait !== undefined) await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
    if (!ok) {
      console.error(
        "[emit-stage] cell prefetch failed after retries:",
        lastErr instanceof Error ? lastErr.name : "unknown",
      )
      return { pairs, failed: true }
    }
  }
  return { pairs, failed: false }
}

/**
 * Serves cell pairs to `stageOne`: from the batch prefetch, with a single-cell
 * query as the fallback for anything the prefetch did not cover — an id the
 * static pre-pass could not resolve, or a prefetch that failed outright. Both
 * are memoized, so no cell is ever read twice in one batch.
 */
class CellPairReader {
  /** Cells the batched prefetch covered. */
  readonly prefetched: number
  /** Per-cell queries the prefetch did not cover. Zero on the normal path. */
  fallbackQueries = 0

  constructor(
    private readonly db: AquillaDb,
    private readonly projectId: string,
    private readonly lane: string,
    private readonly pairs: Map<string, CellPair>,
  ) {
    this.prefetched = pairs.size
  }

  async load(fileId: string, cellId: string): Promise<CellPair> {
    const key = pairKey(fileId, cellId)
    const hit = this.pairs.get(key)
    if (hit) return hit
    this.fallbackQueries++
    const pair = await fetchCellPair(this.db, this.projectId, fileId, cellId, this.lane)
    this.pairs.set(key, pair)
    return pair
  }
}

type Verdict =
  | { kind: "staged"; event: StagedEvent; sourceValue?: string }
  | { kind: "rejected"; reason: string }
  | { kind: "stale"; reason: string }

/** AQU-1068: the project's cell-editing tier, or null for nobody. Best-effort
 *  in the same sense as the lint rules — but failing CLOSED, because the
 *  refusing answer is the safe one here. */
async function loadCellEditingFloor(db: AquillaDb, projectId: string): Promise<number | null> {
  try {
    const row = await db
      .prepare(`SELECT settings FROM project_settings WHERE project_id = ?`)
      .bind(projectId)
      .first<{ settings: string | null }>()
    if (!row?.settings) return null
    return cellEditingFloorFromSettings(JSON.parse(row.settings))
  } catch {
    return null
  }
}

async function stageOne(
  /** AQU-1670: batch-prefetched cell reads; see CellPairReader. */
  pairs: CellPairReader,
  raw: RawEmitEvent,
  ctx: EmitStageContext,
  /**
   * AQU-1068: the project's cell-editing tier, resolved ONCE per batch by
   * `stageEvents` and threaded in — `undefined` when the batch contains no
   * kind that needs it, so an ordinary drafting emit never reads settings.
   */
  cellEditingFloor?: number | null,
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

  // 1b. AQU-1068: adding and removing cells is gated on the project's
  // `cellEditingFloor` as well as the static floor above.
  //
  // THIS IS NOW THE ONLY PLACE THE TIER IS ENFORCED FOR THE AGENT, and that is
  // deliberate rather than an accident of layering. Until 2026-09-09 the /events
  // perimeter checked the tier too, and this check merely spared the user a 403
  // in the middle of an approved changeset. The perimeter stopped checking it
  // (see sync-worker authorize.ts: enforcing it there silently refused
  // audio-cue re-import, DCS import and diarization), so a proposal staged past
  // this line would now be ACCEPTED by the server. We refuse anyway, because
  // the tier decides which buttons exist and an Apply button is a button: the
  // agent should offer exactly what the person could do by hand, and no more.
  if (isCellEditingKind(kind)) {
    if (cellEditingFloor == null) {
      return {
        kind: "rejected",
        reason: `adding or removing cells is not enabled for this project (${kind})`,
      }
    }
    if (ctx.roleLevel < cellEditingFloor) {
      return {
        kind: "rejected",
        reason: `role too low to add or remove cells: this project requires ${ROLE_NAME[cellEditingFloor] ?? cellEditingFloor} (${cellEditingFloor}), you act as ${ROLE_NAME[ctx.roleLevel] ?? ctx.roleLevel} (${ctx.roleLevel})`,
      }
    }
    // The second gate — removing an IMPORTED cell — is deliberately NOT
    // mirrored here. It needs the live cell's metadata to answer, the
    // perimeter already enforces it per event, and a staging-time guess would
    // be a second opinion that can disagree. This one is cheap and settled.
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

  if (CELL_CREATE_KINDS.has(kind)) {
    // AQU-890. A create MINTS a row, so it inverts every assumption the
    // chain-advancing branch below makes: there is no parent, no `before`, and
    // an id that already resolves is a collision rather than the target.
    if (!fileId) return { kind: "rejected", reason: `${kind} needs fileId` }
    if (typeof payload.value !== "string") {
      return { kind: "rejected", reason: `${kind} payload needs a string \`value\`` }
    }

    // The anchor is the EXISTING row the new one lands after (null = first).
    // Validating it here is what keeps a mis-anchored row from being staged
    // into a silently wrong position.
    const anchor = payload.anchorCellId
    if (anchor !== undefined && anchor !== null) {
      if (typeof anchor !== "string") {
        return { kind: "rejected", reason: "anchorCellId must be a string or null" }
      }
      const anchorPair = await pairs.load(fileId, anchor)
      if (!anchorPair.source && !anchorPair.target) {
        return {
          kind: "rejected",
          reason: `anchorCellId ${ctx.aliases.alias(anchor, "c")} does not exist in that file — re-read it`,
        }
      }
    } else {
      payload.anchorCellId = null
    }

    if (cellId) {
      const pair = await pairs.load(fileId, cellId)
      const occupied = kind === "source.cell.create" ? pair.source : pair.target
      if (occupied) {
        const commitKind = kind === "source.cell.create" ? "source.cell.commit" : "target.cell.commit"
        return {
          kind: "rejected",
          reason: `a ${kind === "source.cell.create" ? "source" : "target"} cell already exists at that id — use ${commitKind} to change it`,
        }
      }
    } else {
      // The model has no way to know a free id, so it does not have to supply
      // one; the client's apply path repeats this id into the payload.
      cellId = crypto.randomUUID()
    }
    payload.cellId = cellId

    if (typeof payload.canonicalRef === "string") display.canonicalRef = payload.canonicalRef
    display.after = payload.value
    // Provenance injection (AQU-292), same as target.cell.commit.
    payload.ai_suggestion = true
    payload.agent_run_id = ctx.runId
  } else if (needsCell || kind === "comment.create") {
    if (needsCell && (!fileId || !cellId)) {
      return { kind: "rejected", reason: `${kind} needs fileId and cellId` }
    }
    if (fileId && cellId) {
      const pair = await pairs.load(fileId, cellId)
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
        // AQU-1447: the lane rides on payload.targetLang; absent = default lane.
        // The run's lane always wins over anything the model wrote.
        if (ctx.lane) payload.targetLang = ctx.lane
        else delete payload.targetLang
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

/**
 * AQU-846: resolve display names for every file the batch touches, so both the
 * proposal card and the summary line can say where the changes land. Names are
 * cosmetic — a lookup failure must never fail the staging.
 */
async function resolveFileNames(
  db: AquillaDb,
  projectId: string,
  fileIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (fileIds.length === 0) return names
  const placeholders = fileIds.map(() => "?").join(", ")
  const { results } = await db
    .prepare(`SELECT id, name FROM files WHERE project_id = ? AND id IN (${placeholders})`)
    .bind(projectId, ...fileIds)
    .all<{ id: string; name: string }>()
  for (const row of results ?? []) names.set(row.id, row.name)
  return names
}

/**
 * AQU-1670: every (fileId, cellId) the batch could need, resolved statically.
 * Alias and `:var` resolution is pure, so this costs nothing but lets the
 * whole batch be read in one query.
 *
 * Unresolvable or absent ids are skipped rather than reported: `stageOne`
 * re-resolves each event and owns the real verdict, and the reader falls back
 * to a single query for anything missed here. So this pass is allowed to be
 * incomplete — missing a cell costs one fallback query, never a wrong answer,
 * and naming a cell the batch turns out not to need costs one extra row.
 */
function collectBatchCells(
  rawEvents: readonly unknown[],
  ctx: EmitStageContext,
): { fileId: string; cellId: string }[] {
  const seen = new Set<string>()
  const cells: { fileId: string; cellId: string }[] = []

  const add = (fileId: string, cellId: unknown) => {
    if (typeof cellId !== "string" || cellId.length === 0) return
    const resolved = resolveRef(cellId, ctx)
    if (!resolved.ok) return
    const key = pairKey(fileId, resolved.value)
    if (seen.has(key)) return
    seen.add(key)
    cells.push({ fileId, cellId: resolved.value })
  }

  for (const rawEvent of rawEvents) {
    const raw = rawEvent as RawEmitEvent
    if (typeof raw !== "object" || raw === null || typeof raw.kind !== "string") continue
    // stageOne only ever reads cells under an explicit fileId; without one the
    // event is rejected before it touches the database.
    if (typeof raw.fileId !== "string" || raw.fileId.length === 0) continue
    const file = resolveRef(raw.fileId, ctx)
    if (!file.ok) continue
    add(file.value, raw.cellId)
    if (CELL_CREATE_KINDS.has(raw.kind)) {
      // A create also reads the row it anchors after (AQU-890).
      const payload =
        raw.payload && typeof raw.payload === "object"
          ? (raw.payload as Record<string, unknown>)
          : {}
      add(file.value, payload.anchorCellId)
    }
  }
  return cells
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
    // AQU-846: name the destination file(s) — the summary is the headline the
    // user reads before approving, and "12× target.cell.commit (GEN 1:1 – 1:12)"
    // never said which file those refs live in.
    const files = [...new Set(list.map((e) => e.display.fileName).filter(Boolean) as string[])]
    const where =
      files.length === 0 ? "" : files.length === 1 ? ` in ${files[0]}` : ` in ${files.join(", ")}`
    parts.push(`${list.length}× ${kind}${span}${where}`)
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
  const startedAt = Date.now()
  const staged: StagedEvent[] = []
  const lines: string[] = ["i|kind|ref|verdict"]
  let rejected = 0
  let stale = 0

  // Deterministic lint on staged drafts: load the project's enabled rules once
  // per emit so the MODEL sees violations and can redraft before the user does.
  const anyCommit = rawEvents.some(
    (r) => (r as RawEmitEvent)?.kind === "target.cell.commit",
  )
  const lintRules = anyCommit ? await loadLintRules(db, ctx.projectId) : []
  const lintLines: string[] = []

  // Same once-per-emit discipline as the lint rules above: only read settings
  // when the batch actually contains a kind that needs the answer.
  const anyCellEditing = rawEvents.some(
    (r) => typeof (r as RawEmitEvent)?.kind === "string" && isCellEditingKind((r as RawEmitEvent).kind as string),
  )
  const cellEditingFloor = anyCellEditing ? await loadCellEditingFloor(db, ctx.projectId) : undefined

  // AQU-1670: ONE read for every cell the batch names, BEFORE the per-event
  // loop. This is what keeps staging flat in cell count instead of one
  // round-trip per proposed cell — see the batched-reads block above.
  const prefetch = await prefetchCellPairs(
    db,
    ctx.projectId,
    ctx.lane,
    collectBatchCells(rawEvents, ctx),
  )
  const pairs = new CellPairReader(db, ctx.projectId, ctx.lane, prefetch.pairs)

  for (let i = 0; i < rawEvents.length; i++) {
    const raw = rawEvents[i] as RawEmitEvent
    const kind = typeof raw?.kind === "string" ? raw.kind : "?"
    let verdict: Verdict
    try {
      verdict = await stageOne(pairs, raw, ctx, cellEditingFloor)
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
      if (verdict.kind === "stale") stale++
      else rejected++
      lines.push(`${i + 1}|${kind}|∅|${verdict.kind}: ${verdict.reason}`)
    }
  }

  if (lintLines.length > 0) {
    lines.push(
      ...lintLines,
      "Fix the NEEDS REVIEW drafts and re-emit them (same cellIds) — the corrected versions replace these in the proposal.",
    )
  }

  // AQU-846: stamp each staged event with its file's display name before the
  // proposal leaves the server — the approval UI has only what `display` carries.
  if (staged.length > 0) {
    try {
      const fileIds = [...new Set(staged.map((e) => e.fileId).filter(Boolean) as string[])]
      const names = await resolveFileNames(db, ctx.projectId, fileIds)
      for (const event of staged) {
        const name = event.fileId ? names.get(event.fileId) : undefined
        if (name) event.display.fileName = name
      }
    } catch {
      /* naming is cosmetic — never fail a staged batch over it */
    }
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

  // AQU-1670: report the outcome before returning, so a staging path that
  // starts scaling with cell count again is visible in PostHog rather than
  // only in a partner's 522.
  if (ctx.onStageOutcome) {
    try {
      ctx.onStageOutcome({
        runId: ctx.runId,
        projectId: ctx.projectId,
        requested: rawEvents.length,
        staged: staged.length,
        rejected,
        stale,
        durationMs: Date.now() - startedAt,
        cellsPrefetched: pairs.prefetched,
        fallbackQueries: pairs.fallbackQueries,
        status: prefetch.failed
          ? "prefetch_failed"
          : staged.length > 0
            ? "staged"
            : "nothing_staged",
      })
    } catch {
      /* telemetry must never break a staged batch */
    }
  }

  return { proposal, modelVerdictBlock: lines.join("\n") }
}
