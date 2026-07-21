// AQU-AGENT §2/§3 — agent-channel memory & brief WRITE proposals.
//
// The harness cannot call auth-worker's /api/v2 memory routes in-process, so it
// inserts proposals directly with the SAME validation rules those routes
// enforce (contracts §3). Everything an agent writes is status `proposed` and
// carries provenance {runId, sessionId}. A human reviews/approves via W1C's
// routes + W1E's UI — the agent never approves its own memory.
//
// W1C owns the table shapes (db/postgres/migrations/0066_agent_memory.sql):
//   agent_memories(id, project_id, path, content, status, rationale,
//                  provenance jsonb, created_by, ...)
//   project_brief_proposals(id, project_id, content, rationale, status,
//                           created_by, ...)

/** Path shape an agent-authored memory must match (contracts §3). */
export const MEMORY_PATH_RE = /^[a-z0-9-/]+\.md$/

/** Max memory content size (contracts §3). */
export const MEMORY_MAX_BYTES = 10 * 1024

/** Secret patterns rejected in memory/brief content (contracts §3). A match
 *  means the model tried to persist a credential — refuse, don't sanitize. */
export const SECRET_PATTERNS: RegExp[] = [
  /aqk_/,
  /sk-/,
  /-----BEGIN/,
  /AKIA[0-9A-Z]{16}/,
  /password\s*[:=]/i,
]

export interface MemoryValidationOk {
  ok: true
}
export interface MemoryValidationFail {
  ok: false
  /** Stable code the tool surfaces; `validation_failed` per contracts §2. */
  code: "validation_failed"
  message: string
}
export type MemoryValidation = MemoryValidationOk | MemoryValidationFail

/** UTF-8 byte length (content cap is bytes, not chars — a multibyte script
 *  must not slip past a char-count cap). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength
}

/** Validate a memory path per contracts §3. */
export function validateMemoryPath(path: string): MemoryValidation {
  if (!MEMORY_PATH_RE.test(path)) {
    return {
      ok: false,
      code: "validation_failed",
      message: `path must match ${MEMORY_PATH_RE.source} (lowercase, digits, dashes, slashes, ending .md)`,
    }
  }
  return { ok: true }
}

/** Validate content size + secret patterns per contracts §3. Shared by memory
 *  and brief writes. */
export function validateContent(content: string): MemoryValidation {
  if (byteLength(content) > MEMORY_MAX_BYTES) {
    return {
      ok: false,
      code: "validation_failed",
      message: `content exceeds ${MEMORY_MAX_BYTES} bytes — split it or summarize`,
    }
  }
  for (const re of SECRET_PATTERNS) {
    if (re.test(content)) {
      return {
        ok: false,
        code: "validation_failed",
        message: "content matches a secret pattern — memory may not store credentials or keys",
      }
    }
  }
  return { ok: true }
}

/** Provenance stamped onto every agent-authored proposal. */
export interface MemoryProvenance {
  runId: string
  sessionId?: string | null
  credentialId?: string
}

export interface ProposeMemoryInput {
  projectId: string
  path: string
  content: string
  rationale: string
  createdBy: string
  provenance: MemoryProvenance
}

export type ProposeMemoryResult =
  | { ok: true; memoryId: string; status: "proposed" }
  | { ok: false; code: "validation_failed"; message: string }

/** Insert a proposed memory (validation first). Never approves — status is
 *  pinned `proposed`. */
export async function proposeMemory(
  db: AquillaDb,
  input: ProposeMemoryInput,
): Promise<ProposeMemoryResult> {
  const pathCheck = validateMemoryPath(input.path)
  if (!pathCheck.ok) return pathCheck
  const contentCheck = validateContent(input.content)
  if (!contentCheck.ok) return contentCheck

  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO agent_memories
          (id, project_id, path, content, status, rationale, provenance, created_by)
       VALUES (?, ?, ?, ?, 'proposed', ?, ?::jsonb, ?)`,
    )
    .bind(
      id,
      input.projectId,
      input.path,
      input.content,
      input.rationale,
      JSON.stringify(input.provenance),
      input.createdBy,
    )
    .run()
  return { ok: true, memoryId: id, status: "proposed" }
}

export interface ProposeBriefInput {
  projectId: string
  content: string
  rationale: string
  createdBy: string
}

export type ProposeBriefResult =
  | { ok: true; proposalId: string; status: "proposed" }
  | { ok: false; code: "validation_failed"; message: string }

/** Insert a proposed brief update (content validation only — a brief has no
 *  path). Never approves. */
export async function proposeBriefUpdate(
  db: AquillaDb,
  input: ProposeBriefInput,
): Promise<ProposeBriefResult> {
  const contentCheck = validateContent(input.content)
  if (!contentCheck.ok) return contentCheck

  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO project_brief_proposals
          (id, project_id, content, rationale, status, created_by)
       VALUES (?, ?, ?, ?, 'proposed', ?)`,
    )
    .bind(id, input.projectId, input.content, input.rationale, input.createdBy)
    .run()
  return { ok: true, proposalId: id, status: "proposed" }
}
