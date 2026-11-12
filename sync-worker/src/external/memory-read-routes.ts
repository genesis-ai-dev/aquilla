// External Living Memory read surface (AQU-1229).
//
//   GET /api/v1/external/projects/:projectId/memory?status=&kind=&limit=&cursor=
//   GET /api/v1/external/projects/:projectId/files/:fileId/cells/:cellId/memory
//
// Why these exist: Living Memory is the product story — the brief, the
// approved examples/decisions/notes the in-app agent learns from — and an agent
// holding a PAT could read none of it. The write commands (AQU-1228) can stage
// entries; nothing could read them back, so an agent could not tell whether an
// entry already existed, had been approved, or was reaching the prompt at all.
//
// Contract: **parity with the in-app Memory surface** (AQU-932). Whatever a
// human sees on the project's Living Memory page, an agent reads here — same
// rows, same statuses, same ordering (most-recently-updated first) — with
// author identities pseudonymized per the agent-facing PII default (AQU-1180).
//
// Both routes delegate to `db/shared/agent-memory.ts`, the same module the
// in-app surface and the in-app agent's own prompt assembly use. No query or
// retrieval logic is reimplemented here: the per-cell route calls
// `buildMemoryContext`, i.e. the agent's actual retrieval path, so what it
// reports is what the next draft would be given rather than a second
// description of it.
//
// Auth/scope/throttle: identical to the rest of the read tier — a shared
// `authenticateAndScope` (credential validity → org/project scope → live role
// floor of VIEWER) plus the shared per-credential read budget, both imported
// from read-routes.ts.

import {
  buildMemoryContext,
  getBrief,
  listMemories,
  memoryFirstLine,
  memoryKindForPath,
  MEMORY_INDEX_RENDER_CAP,
  type AgentMemory,
  type MemoryKind,
  type MemoryProvenance,
  type MemoryStatus,
} from "../../../db/shared/agent-memory"
import {
  briefFilledSectionCount,
  isBriefL1Stale,
  readBriefFromSettings,
} from "../../../db/shared/brief"
import { loadProjectSettings } from "../../../db/shared/projects"
import {
  briefInstructionsText,
  resolveTranslationInstructions,
  storedTranslationInstructions,
} from "../../../db/shared/translation-instructions"
import { externalError } from "./errors"
import { authenticateAndScope, checkReadRateLimit, type ExternalReadsEnv } from "./read-auth"
import { paginate, parsePageParams } from "./pagination"
import { mapAuthor, resolveAuthorshipPolicy, type AuthorshipPolicy } from "./pii"

const MEMORY_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/memory$/
const CELL_MEMORY_RE =
  /^\/api\/v1\/external\/projects\/([^/]+)\/files\/([^/]+)\/cells\/([^/]+)\/memory$/

const MEMORY_MAX_LIMIT = 200

const STATUSES: readonly MemoryStatus[] = ["proposed", "approved", "rejected", "archived"]
const KINDS: readonly MemoryKind[] = ["example", "decision", "note", "observation", "other"]

// ---------------------------------------------------------------------------
// PII: author identities, delegated to external/pii.ts (AQU-1180)
// ---------------------------------------------------------------------------

// `agent_memories.created_by` / `reviewed_by` and `project_briefs.updated_by`
// hold USERNAMES (see db/postgres/schema.sql), which name real translators.
//
// This used to run its own HMAC pseudonymizer here -- a second implementation
// of the same idea in external/pii.ts, with a different hex length and id
// prefix (author_<12 hex> vs. pii.ts's u_<8 hex>) -- that (a) never checked a
// project's `agentAuthorship: 'none'` opt-out, so this route kept handing back
// pseudonyms for a project that asked for no identity exposure at all, and (b)
// never checked a credential's `pii: true` grant, so an OWNER who explicitly
// minted a real-identity credential still only ever got pseudonyms here.
// Found in the 2026-09-17 pen test. Delegating to `resolveAuthorshipPolicy` /
// `mapAuthor` fixes both, and as a side effect makes the same translator
// resolve to the same opaque id here as on the comments/cells routes.
//
// Scoped per project by pii.ts on purpose: the same person is a different
// pseudonym in two projects, so an agent with credentials on both cannot
// correlate contributors across them. Within one project the pseudonym is
// stable, so "these four decisions came from one person" survives -- which is
// the part that has legitimate analytical value.

/** Build a memoized `username -> mapped identity` mapper for one project. */
function createIdentityMapper(
  policy: AuthorshipPolicy,
  secret: string | undefined,
  projectId: string,
): (name: string | null) => Promise<string | null | undefined> {
  const cache = new Map<string, string | null | undefined>()
  return async (name: string | null): Promise<string | null | undefined> => {
    if (name === null || name === "") return name
    if (!cache.has(name)) {
      cache.set(name, await mapAuthor(name, policy, secret, projectId))
    }
    return cache.get(name)
  }
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

interface ExternalMemoryEntry {
  id: string
  path: string
  kind: MemoryKind
  status: MemoryStatus
  humanEdited: boolean
  content: string
  firstLine: string
  rationale: string | null
  /** Pseudonymous by default, real on a `pii` credential, ABSENT entirely when
   *  the project has set `agentAuthorship: 'none'` — see createIdentityMapper. */
  createdBy: string | null | undefined
  reviewedBy: string | null | undefined
  /** Agent run/session that proposed the entry. `credentialId` is dropped: it
   *  names another person's token, which is the same PII class as the author. */
  provenance: { runId?: string; sessionId?: string } | null
  version: number
  createdAt: string
  updatedAt: string
  /** True when this entry is inside the slice retrieval actually injects —
   *  approved AND within MEMORY_INDEX_RENDER_CAP of the most-recently-updated
   *  approved entries. An approved entry past the cap reads `false`: it exists
   *  and a human sees it, but no draft is currently getting it. */
  inRetrieval: boolean
}

/** The brief block reports the interview record (`settings.translationBrief`)
 *  and its rendered L1 summary. AQU-2342: no prompt reads the brief directly —
 *  every drafting prompt reads the ONE project instructions text, which is
 *  composed on read from the brief (and the other legacy sources) until a
 *  maintainer writes `translationInstructions`. `instructions` reports that
 *  resolved text; `legacyBrief` keeps its old shape and now carries it too, so
 *  a caller reading "the brief the AI sees" keeps reading the truth. */
interface ExternalBrief {
  /** `translationBrief.l1Summary`, or "" when the brief has no rendered
   *  summary yet. */
  content: string
  /** The brief record's own version (not the settings version). */
  version: number
  updatedAt: string | null
  updatedBy: string | null | undefined
  source: "translationBrief"
  /** Whether the brief currently feeds the prompts: the project has NOT written
   *  `translationInstructions` and the brief has a summary or answered
   *  sections, so the instructions composed on read carry it. */
  reachesCopilot: boolean
  /** Filled interview sections. */
  sections: number
  /** The sections moved after the L1 was rendered (or no L1 exists) —
   *  RegenerateBriefSummary fixes it. */
  l1Stale: boolean
}

interface LegacyBrief {
  /** AQU-2342: the RESOLVED project instructions (what prompts carry). */
  content: string
  /** The `project_briefs` row version (0 when no row). */
  version: number
}

/** The ONE text every drafting prompt carries (AQU-2342). */
interface ExternalInstructions {
  content: string
  /** True when `translationInstructions` is written; false when `content` is
   *  composed on read from the brief and the other legacy sources. */
  stored: boolean
}

async function loadExternalBrief(
  db: AquillaDb,
  projectId: string,
  pseudonymize: (name: string | null) => Promise<string | null | undefined>,
): Promise<{ brief: ExternalBrief; legacyBrief: LegacyBrief | null; instructions: ExternalInstructions }> {
  const { settings } = await loadProjectSettings(db, projectId)
  const record = readBriefFromSettings(settings)
  const legacy = await getBrief(db, projectId)
  const stored = storedTranslationInstructions(settings) !== null
  const content = resolveTranslationInstructions(settings, { projectBriefText: legacy.content })
  const brief: ExternalBrief = record
    ? {
        content: record.l1Summary ?? "",
        version: record.version,
        updatedAt: record.updatedAt || null,
        updatedBy: await pseudonymize(record.updatedBy || null),
        source: "translationBrief",
        reachesCopilot: !stored && briefInstructionsText(record) !== "",
        sections: briefFilledSectionCount(record),
        l1Stale: isBriefL1Stale(record),
      }
    : {
        content: "",
        version: 0,
        updatedAt: null,
        updatedBy: null,
        source: "translationBrief",
        reachesCopilot: false,
        sections: 0,
        l1Stale: true,
      }
  const legacyBrief: LegacyBrief | null =
    content !== "" ? { content, version: legacy.version } : null
  return { brief, legacyBrief, instructions: { content, stored } }
}

/** Keep the run/session ids (they identify an agent run, which is what a
 *  caller legitimately wants to trace) and drop `credentialId`, which names a
 *  person's token — the same PII class as the author fields. A provenance
 *  blob carrying nothing else becomes null rather than an empty object, so a
 *  caller can test truthiness instead of counting keys. */
function scrubProvenance(
  p: MemoryProvenance | null,
): { runId?: string; sessionId?: string } | null {
  if (p === null) return null
  const out = {
    ...(p.runId !== undefined ? { runId: p.runId } : {}),
    ...(p.sessionId !== undefined ? { sessionId: p.sessionId } : {}),
  }
  return Object.keys(out).length > 0 ? out : null
}

function toExternalEntry(
  m: AgentMemory,
  inRetrieval: boolean,
  createdBy: string | null | undefined,
  reviewedBy: string | null | undefined,
): ExternalMemoryEntry {
  return {
    id: m.id,
    path: m.path,
    kind: memoryKindForPath(m.path),
    status: m.status,
    humanEdited: m.humanEdited,
    content: m.content,
    firstLine: memoryFirstLine(m.content),
    rationale: m.rationale,
    createdBy,
    reviewedBy,
    provenance: scrubProvenance(m.provenance),
    version: m.version,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    inRetrieval,
  }
}

/** Paths retrieval is currently injecting, in prompt order. Derived from the
 *  same list + ordering + cap `buildMemoryContext` uses, so it cannot disagree
 *  with the prompt. */
function injectedPaths(all: readonly AgentMemory[]): Set<string> {
  return new Set(
    all
      .filter((m) => m.status === "approved")
      .slice(0, MEMORY_INDEX_RENDER_CAP)
      .map((m) => m.path),
  )
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects/:projectId/memory
// ---------------------------------------------------------------------------

async function handleMemoryList(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response
  const db = env.AQUILLA_PG as AquillaDb
  const limited = await checkReadRateLimit(db, authed.ctx.credential)
  if (limited) return limited

  const url = new URL(request.url)

  const qStatus = url.searchParams.get("status")
  if (qStatus !== null && !STATUSES.includes(qStatus as MemoryStatus)) {
    return externalError(
      "validation_failed",
      `invalid status "${qStatus}" — one of ${STATUSES.join("|")}`,
      400,
    )
  }
  const qKind = url.searchParams.get("kind")
  if (qKind !== null && !KINDS.includes(qKind as MemoryKind)) {
    return externalError(
      "validation_failed",
      `invalid kind "${qKind}" — one of ${KINDS.join("|")}`,
      400,
    )
  }

  const { limit, offset } = parsePageParams(url, { defaultLimit: 50, maxLimit: MEMORY_MAX_LIMIT })

  // Fetch every status once (a project's memory is path-keyed and 10KB-capped
  // per entry, so this is a small table) and filter in memory: `inRetrieval`
  // and the retrieval counts below are properties of the WHOLE approved set,
  // and a status-filtered query could not compute them.
  const all = await listMemories(db, projectId)
  const injected = injectedPaths(all)
  const approvedCount = all.filter((m) => m.status === "approved").length

  const filtered = all.filter(
    (m) =>
      (qStatus === null || m.status === qStatus) &&
      (qKind === null || memoryKindForPath(m.path) === qKind),
  )
  const page = paginate(filtered, offset, limit)

  const policy = await resolveAuthorshipPolicy(db, authed.ctx.credential, projectId)
  const pseudonymize = createIdentityMapper(policy, env.SYNC_SECRET_KEY, projectId)
  const { brief, legacyBrief, instructions } = await loadExternalBrief(db, projectId, pseudonymize)
  const data: ExternalMemoryEntry[] = await Promise.all(
    page.data.map(async (m) =>
      toExternalEntry(
        m,
        injected.has(m.path) && m.status === "approved",
        await pseudonymize(m.createdBy),
        await pseudonymize(m.reviewedBy),
      ),
    ),
  )

  return Response.json({
    instructions,
    brief,
    ...(legacyBrief ? { legacyBrief } : {}),
    data,
    nextCursor: page.nextCursor,
    retrieval: {
      scope: "project",
      indexRenderCap: MEMORY_INDEX_RENDER_CAP,
      approvedCount,
      injectedCount: injected.size,
    },
    hints: {
      kinds:
        'kind is derived from the path prefix: examples/ -> example, decisions/ -> decision, notes/ -> note, observations/ -> observation. Filter with ?kind= or ?status=.',
      identities:
        "createdBy/reviewedBy/brief.updatedBy are per-project pseudonyms by default, not usernames — stable within this project, uncorrelatable across projects. Real usernames only on a credential minted `pii: true`; absent entirely when the project has set agentAuthorship: 'none'.",
      brief:
        "instructions.content is THE text every drafting prompt carries (copilot, prompt-preview parts.instructions, the in-app agent and its draft tool, DraftCells, Autopilot). instructions.stored false means it is composed on read from the brief, a customized systemPrompt, Living Memory instruction entries and the legacy agent brief; write it with PatchSettings translationInstructions and those stop reaching any prompt. brief is the interview record (brief.content = its rendered L1 summary); brief.reachesCopilot says whether it currently feeds the instructions. legacyBrief keeps its old shape for older callers and carries the same resolved instructions text.",
      perCell:
        "GET /api/v1/external/projects/:projectId/files/:fileId/cells/:cellId/memory returns what retrieval would inject for one cell's draft.",
    },
  })
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects/:projectId/files/:fileId/cells/:cellId/memory
// ---------------------------------------------------------------------------

// Honesty note, and the reason this route reports its own scope: retrieval is
// **project-scoped today**. The agent's prompt carries the project instructions
// plus the capped approved-memory index (`buildMemoryContext`), identically for every cell —
// there is no per-cell narrowing (no embedding search, no anchor filter). So
// this route returns that set for the named cell rather than inventing a
// per-cell ranking the agent does not actually perform, and says so in
// `retrieval.scope`/`retrieval.note`. An agent that assumed otherwise would
// mis-predict its own drafts. If per-cell retrieval later lands (AQU-1232's
// similarity search is the likely vehicle), this route narrows with it and the
// `scope` field is how a caller detects the change.
//
// The cell is still validated (404 when it does not exist): the route answers
// "what would this cell's draft be given" and a caller typo'ing a cell id
// deserves an error, not a project-wide dump that looks like an answer.

async function handleCellMemory(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
  fileId: string,
  cellId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response
  const db = env.AQUILLA_PG as AquillaDb
  const limited = await checkReadRateLimit(db, authed.ctx.credential)
  if (limited) return limited

  const cell = await db
    .prepare(
      "SELECT 1 AS ok FROM cells WHERE project_id = ? AND file_id = ? AND cell_id = ? LIMIT 1",
    )
    .bind(projectId, fileId, cellId)
    .first<{ ok: number }>()
  if (!cell) {
    return externalError("not_found", `no cell ${cellId} in file ${fileId}`, 404)
  }

  // The in-app agent's own retrieval path — not a reimplementation of it.
  const memory = await buildMemoryContext(db, projectId)
  const shown = memory.memoryIndex.slice(0, MEMORY_INDEX_RENDER_CAP)
  const overflow = memory.memoryIndex.length - shown.length

  const policy = await resolveAuthorshipPolicy(db, authed.ctx.credential, projectId)
  const pseudonymize = createIdentityMapper(policy, env.SYNC_SECRET_KEY, projectId)
  const { brief, legacyBrief, instructions } = await loadExternalBrief(db, projectId, pseudonymize)

  return Response.json({
    cell: { fileId, cellId },
    instructions,
    brief,
    ...(legacyBrief ? { legacyBrief } : {}),
    // Index entries only — path + first line + human-edited marker — because
    // that is literally what the prompt carries. Full text is fetched
    // just-in-time by the agent's read_memory tool, and by an agent from the
    // list route above.
    entries: shown.map((e) => ({
      path: e.path,
      kind: memoryKindForPath(e.path),
      firstLine: e.firstLine,
      humanEdited: e.humanEdited,
    })),
    retrieval: {
      scope: "project",
      indexRenderCap: MEMORY_INDEX_RENDER_CAP,
      approvedCount: memory.memoryIndex.length,
      injectedCount: shown.length,
      truncated: overflow > 0,
      note:
        "Retrieval is project-scoped: the in-app agent's chat carries the project instructions plus the most-recently-updated approved memory index, capped at indexRenderCap, identically for every cell in this project. The drafting prompts (copilot, draft tool, DraftCells, Autopilot) carry the instructions but not this index. No per-cell narrowing happens yet — entries are not ranked or filtered against this cell. Only paths and first lines are injected; the agent pulls full text just-in-time, and so can you via GET /api/v1/external/projects/:projectId/memory." +
        (overflow > 0
          ? ` ${overflow} further approved ${overflow === 1 ? "entry is" : "entries are"} NOT injected (past the cap).`
          : ""),
    },
  })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleExternalMemoryReadRequest(
  request: Request,
  env: ExternalReadsEnv,
): Promise<Response | null> {
  const url = new URL(request.url)

  const listMatch = url.pathname.match(MEMORY_RE)
  const cellMatch = url.pathname.match(CELL_MEMORY_RE)
  if (!listMatch && !cellMatch) return null

  // Claim the path even on the wrong verb, so a POST here gets a 405 that
  // names the right method instead of falling through to discovery-route's
  // "no external API route matches" 404 (which would be a lie — it matches,
  // it is just read-only).
  if (request.method !== "GET") {
    return Response.json(
      {
        error: {
          code: "validation_failed",
          message: `${url.pathname} is read-only — use GET. Memory entries are written through the changeset prepare/approve flow (POST .../changesets), never by writing to this path.`,
        },
      },
      { status: 405, headers: { Allow: "GET" } },
    )
  }

  if (listMatch) return handleMemoryList(request, env, decodeURIComponent(listMatch[1]))
  return handleCellMemory(
    request,
    env,
    decodeURIComponent((cellMatch as RegExpMatchArray)[1]),
    decodeURIComponent((cellMatch as RegExpMatchArray)[2]),
    decodeURIComponent((cellMatch as RegExpMatchArray)[3]),
  )
}
