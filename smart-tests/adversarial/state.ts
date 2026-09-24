import path from "node:path"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { v7 as uuidv7 } from "uuid"
import type { PersistedSession } from "../../e2e/helpers/auth"
import { addProjectMember, createOrg } from "../../e2e/helpers/frontier-api"
import {
  mintSyncToken, readCellHistory, readProjectedCells, seedProjectWithFile, type SeededProject,
} from "../../e2e/helpers/seed-project"
import { OUTBOX_SCHEMA_VERSION } from "../../src/lib/sync/outbox-types"
import type { AdversarialUser, TargetKind } from "./target"
import type { Snapshot } from "./invariants"

const directory = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURE = path.join(directory, "../fixtures/smart-edit.md")

// Read at call time: the launcher and global setup set these per target.
const identity = () => process.env.VITE_FRONTIER_BASE ?? ""
const sync = () => process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? ""}`

/** Shared by every worker; written once by global setup. */
export interface RunContext {
  runId: string
  kind: TargetKind
  /** [primary agent, second agent, fixture owner]. */
  sessions: PersistedSession[]
  orgId: number
  deployedBuild: { sha: string; branch: string; builtAt: string } | null
}

export const readRunContext = (): RunContext =>
  JSON.parse(readFileSync(process.env.ADVERSARIAL_CONTEXT ?? "", "utf8")) as RunContext

async function json<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) throw new Error(`${operation} failed: HTTP ${response.status}`)
  return await response.json() as T
}

/** Password login, the same endpoint the SPA uses. The password never leaves this process. */
export async function login(user: AdversarialUser): Promise<PersistedSession> {
  const body = await json<{ access_token: string }>(await fetch(`${identity()}/api/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user.username, password: user.password }),
  }), `login ${user.username}`)
  return { jwt: body.access_token, username: user.username, createdAt: new Date().toISOString() }
}

/** The build a deployed target is serving, from the file vite.config.ts writes. */
export async function deployedBuild(baseURL: string): Promise<RunContext["deployedBuild"]> {
  return await json(await fetch(`${baseURL}/version.json`, { cache: "no-store" }), "version.json")
}

export async function createRunOrg(owner: PersistedSession, runId: string): Promise<number> {
  return (await createOrg(owner.jwt, `adv-${runId}`)).id
}

/**
 * One translated, unvalidated file. Every target starts filled so the
 * sign-off control renders and a wrong-row write is detectable.
 */
export async function seedFixture(
  owner: PersistedSession,
  opts: { name: string; orgId?: number; members: { username: string; role: number }[] },
): Promise<{ seeded: SeededProject; rows: string[] }> {
  const seeded = await seedProjectWithFile(owner.jwt, { name: opts.name, fixturePath: FIXTURE, orgId: opts.orgId })
  for (const member of opts.members) await addProjectMember(owner.jwt, seeded.projectId, member.username, member.role)
  const sources = await readProjectedCells(owner.jwt, seeded, "source")
  const token = await mintSyncToken(owner.jwt, seeded.projectId, seeded.fileId)
  const events = seeded.cellIds.map((cellId, index) => ({
    id: uuidv7(),
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    kind: "target.cell.commit",
    projectId: seeded.projectId,
    fileId: seeded.fileId,
    cellId,
    parentId: sources.find((row) => row.cellId === cellId)?.eventId ?? null,
    author: owner.username,
    payload: { value: `Tafsiri ya mstari wa ${index + 1}.` },
    clientTs: Date.now(),
  }))
  const result = await json<{ rejected: unknown[] }>(await fetch(`${sync()}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  }), "seed translations")
  if (result.rejected.length > 0) throw new Error("Seeded translations were rejected")
  const rows = seeded.cellIds.map((cellId) => sources.find((row) => row.cellId === cellId)?.value ?? "")
  return { seeded, rows }
}

/** Authoritative state of the given projects, each read as a user who may see it. */
export async function readSnapshot(entries: { projectId: string; reader: PersistedSession }[]): Promise<Snapshot> {
  const snapshot: Snapshot = { projects: [], files: [], cells: [], comments: [], histories: {}, validators: {} }
  for (const { projectId, reader } of entries) {
    const project = await fetch(`${identity()}/api/v2/projects/${projectId}`, {
      headers: { Authorization: `Bearer ${reader.jwt}` },
    })
    if (project.ok) {
      const { name } = await project.json() as { name: string }
      snapshot.projects.push({ id: projectId, name, present: true })
    } else if (project.status === 403 || project.status === 404) {
      snapshot.projects.push({ id: projectId, name: "", present: false })
      continue
    } else {
      throw new Error(`project read failed: HTTP ${project.status}`)
    }
    const token = await mintSyncToken(reader.jwt, projectId, "any")
    const auth = { headers: { Authorization: `Bearer ${token}` } }
    for (const trash of [false, true]) {
      const { files } = await json<{ files: { fileId: string; name: string }[] }>(await fetch(
        `${sync()}/api/v1/projects/${projectId}/files?limit=200${trash ? "&trash=1" : ""}`, auth), "files read")
      for (const file of files) snapshot.files.push({ projectId, fileId: file.fileId, name: file.name, deleted: trash })
    }
    for (const file of snapshot.files.filter((entry) => entry.projectId === projectId && !entry.deleted)) {
      const ref = { projectId, fileId: file.fileId }
      for (const row of await readProjectedCells(reader.jwt, ref)) {
        snapshot.cells.push({ fileId: file.fileId, cellId: row.cellId, side: row.side, value: row.value,
          validated: row.validated, eventId: row.eventId })
        if (row.side !== "target") continue
        const fileToken = await mintSyncToken(reader.jwt, projectId, file.fileId)
        const { validators } = await json<{ validators: { username: string }[] }>(await fetch(
          `${sync()}/cell-validators?fileId=${file.fileId}&cellId=${encodeURIComponent(row.cellId)}`,
          { headers: { Authorization: `Bearer ${fileToken}` } }), "validators read")
        snapshot.validators[row.cellId] = validators.map((entry) => entry.username)
        const history = await readCellHistory(reader.jwt, ref, row.cellId)
        snapshot.histories[row.cellId] = history.reverse().map((event) => ({
          kind: event.kind, author: event.author,
          value: typeof (event.payload as { value?: unknown } | null)?.value === "string"
            ? (event.payload as { value: string }).value : null,
        }))
      }
    }
    const { comments } = await json<{ comments: { body: string }[] }>(await fetch(
      `${sync()}/api/v1/projects/${projectId}/comments?limit=200`, auth), "comments read")
    for (const comment of comments) snapshot.comments.push({ projectId, body: comment.body })
  }
  return snapshot
}

/** Archive a finished fixture. POST archives; DELETE on the same path restores. */
export async function archiveProject(owner: PersistedSession, projectId: string): Promise<void> {
  const response = await fetch(`${identity()}/api/v2/projects/${projectId}/archive`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.jwt}` },
  })
  if (!response.ok) throw new Error(`archive ${projectId} failed: HTTP ${response.status}`)
}
