// SWARM-TODO(aqu-agent): replace with db/shared/agent-memory once merged.
//
// W1C owns the real `db/shared/agent-memory.ts` exporting
// `buildMemoryContext(db, projectId)`. It does not yet exist in this worktree,
// so W1B codes against the contract signature (AQU-AGENT-CONTRACTS §3) via this
// thin local stub so the branch compiles and tests run standalone. On merge:
// delete this file and import from "../../../../db/shared/agent-memory".
//
// The stub reads the SAME tables W1C will (agent_memories approved rows +
// project_briefs) with parameterized SQL, so behaviour is representative — but
// treat the shape here as provisional until W1C's module lands.

/** One approved memory's index entry: path + its first content line. */
export interface MemoryIndexEntry {
  path: string
  firstLine: string
}

/** The memory context used by prompt assembly (contracts §3 signature). */
export interface MemoryContext {
  /** Human-authored project brief (verbatim), or "" when none. */
  brief: string
  /** Approved-memory index (path + first line) for JIT read_memory. */
  memoryIndex: MemoryIndexEntry[]
  /** Full content of one approved memory by path, or null when absent. */
  readMemory(path: string): Promise<string | null>
}

interface ApprovedRow {
  path: string
  content: string
}

function firstLineOf(content: string): string {
  const nl = content.indexOf("\n")
  const line = (nl === -1 ? content : content.slice(0, nl)).trim()
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/**
 * Build the read-side memory context for a project. Approved memories only
 * (status='approved'); the brief comes from project_briefs. Every failure
 * degrades to empty — prompt grounding is best-effort and must never fail a run.
 */
export async function buildMemoryContext(
  db: AquillaDb,
  projectId: string,
): Promise<MemoryContext> {
  let brief = ""
  let rows: ApprovedRow[] = []

  try {
    const briefRow = await db
      .prepare(`SELECT content FROM project_briefs WHERE project_id = ?`)
      .bind(projectId)
      .first<{ content: string }>()
    brief = briefRow?.content ?? ""
  } catch {
    /* table not migrated yet in this worktree — degrade to no brief */
  }

  try {
    const result = await db
      .prepare(
        `SELECT path, content FROM agent_memories
          WHERE project_id = ? AND status = 'approved'
          ORDER BY path`,
      )
      .bind(projectId)
      .all<ApprovedRow>()
    rows = result.results ?? []
  } catch {
    /* table not migrated yet — degrade to empty index */
  }

  const byPath = new Map(rows.map((r) => [r.path, r.content]))
  const memoryIndex: MemoryIndexEntry[] = rows.map((r) => ({
    path: r.path,
    firstLine: firstLineOf(r.content),
  }))

  return {
    brief,
    memoryIndex,
    readMemory: async (path: string) => byPath.get(path) ?? null,
  }
}
