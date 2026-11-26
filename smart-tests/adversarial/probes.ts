import { v7 as uuidv7 } from "uuid"
import type { PersistedSession } from "../../e2e/helpers/auth"
import { ROLE } from "../../e2e/helpers/frontier-api"
import { mintSyncToken, readProjectedCells, type SeededProject } from "../../e2e/helpers/seed-project"
import { OUTBOX_SCHEMA_VERSION } from "../../src/lib/sync/outbox-types"
import { readTargetLane } from "../target-lane"
import type { Journey } from "./attacks"
import type { AdversarialOutcome, Contract, Snapshot } from "./invariants"
import { probeOutcome, type Sent } from "./probe-verdict"
import { identity, readSnapshot, seedFixture, sync, type RunContext } from "./state"

/*
 * Red-team probes. No model runs here: each probe sends the hostile request
 * itself and the invariant oracle reads what the server kept.
 *
 * These replace four Jev red-team attacks whose passes were empty. Over 57
 * runs (2026-11-19 to 21) the agent told to wipe a file as a viewer typed
 * the file's name into the sidebar filter and stopped, the agent told to
 * sign off twice clicked once, and the agent told to save an empty name
 * could not type one. `observe: "any-action"` counted each as an attempt,
 * and "nothing changed" then read as "the product refused".
 *
 * Every probe also sends a control: the same request from a user who is
 * allowed to make it. A probe whose control does not land proves nothing
 * about the refusal (its request shape is stale), so it ends inconclusive.
 */

export interface ProbeResult {
  /** What the probe attempted, in the words a ticket can carry. */
  goal: string
  outcome: AdversarialOutcome
  sent: Sent[]
  projects: { projectId: string; owner: string }[]
}

export interface Probe {
  id: string
  journey: Journey
  run(run: RunContext, tag: string): Promise<ProbeResult>
}

type FileRef = Pick<SeededProject, "projectId" | "fileId">

const event = (author: string, ref: FileRef, cellId: string, kind: string, parentId: string | null, payload: object) => ({
  id: uuidv7(), schemaVersion: OUTBOX_SCHEMA_VERSION, kind, ...ref, cellId, parentId, author, payload, clientTs: Date.now(),
})

async function postEvents(what: string, token: string, events: object[], log: Sent[]): Promise<void> {
  const response = await fetch(`${sync()}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  })
  log.push({ what, status: response.status })
}

/** Ask for a sync token as the hostile user; a refusal is a result, not an error. */
async function requestToken(what: string, user: PersistedSession, ref: FileRef, log: Sent[]): Promise<string | null> {
  const response = await fetch(`${identity()}/api/v2/sync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.jwt}` },
    body: JSON.stringify(ref),
  })
  log.push({ what, status: response.status })
  return response.ok ? (await response.json() as { token: string }).token : null
}

async function renameProject(what: string, user: PersistedSession, projectId: string, name: string, log: Sent[]): Promise<void> {
  const response = await fetch(`${identity()}/api/v2/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.jwt}` },
    body: JSON.stringify({ name }),
  })
  log.push({ what, status: response.status })
}

const head = (snapshot: Snapshot, cellId: string) =>
  snapshot.cells.find((cell) => cell.cellId === cellId && cell.side === "target")?.eventId ?? null

/** The control: the owner makes the same kind of target write, and it must project. */
async function ownerCommitLands(owner: PersistedSession, seeded: SeededProject, cellId: string, parentId: string | null, value: string, lane: object): Promise<boolean> {
  const token = await mintSyncToken(owner.jwt, seeded.projectId, seeded.fileId)
  await postEvents("control", token, [event(owner.username, seeded, cellId, "target.cell.commit", parentId, { value, ...lane })], [])
  const rows = await readProjectedCells(owner.jwt, seeded, "target")
  return rows.find((row) => row.cellId === cellId)?.value === value
}

const untouched: Contract = { allowed: [], required: [] }

export const PROBES: Probe[] = [
  {
    // A viewer may read a file. Every write a viewer sends must leave it as it was.
    id: "redteam.viewer-wipe-file", journey: "edit",
    async run(run, tag) {
      const [viewer, , owner] = run.sessions
      const { seeded } = await seedFixture(owner, { name: `adv redteam.viewer-wipe-file ${tag}`,
        members: [{ username: viewer.username, role: ROLE.VIEWER }] })
      const readers = [{ projectId: seeded.projectId, reader: owner }]
      const lane = await readTargetLane(owner.jwt, seeded.projectId)
      const before = await readSnapshot(readers)
      const sent: Sent[] = []
      const token = await requestToken("viewer asks for a sync token", viewer, seeded, sent)
      if (token) {
        await postEvents("viewer empties every translation", token, seeded.cellIds.map((cellId) =>
          event(viewer.username, seeded, cellId, "target.cell.commit", head(before, cellId), { value: "", ...lane })), sent)
        await postEvents("viewer signs off a translation", token, [event(viewer.username, seeded, seeded.cellIds[0],
          "cell.validate", null, { editEventId: head(before, seeded.cellIds[0]), ...lane })], sent)
      }
      const after = await readSnapshot(readers)
      const control = await ownerCommitLands(owner, seeded, seeded.cellIds[0], head(after, seeded.cellIds[0]), "", lane)
      return { goal: "As a viewer, empty every translation in the file and sign one off, straight through the sync API.",
        outcome: probeOutcome(before, after, untouched, sent, control), sent,
        projects: [{ projectId: seeded.projectId, owner: owner.username }] }
    },
  },
  {
    // A user with no role on a project must not write to it: not with a token
    // asked for directly, and not with a token minted for a project they own.
    id: "redteam.edit-other-project", journey: "edit",
    async run(run, tag) {
      const [outsider, , owner] = run.sessions
      const foreign = (await seedFixture(owner, { name: `adv redteam.edit-other-project ${tag}`, members: [] })).seeded
      const own = (await seedFixture(outsider, { name: `adv redteam.edit-other-project own ${tag}`, orgId: run.orgId, members: [] })).seeded
      const readers = [{ projectId: foreign.projectId, reader: owner }, { projectId: own.projectId, reader: outsider }]
      const lane = await readTargetLane(owner.jwt, foreign.projectId)
      const before = await readSnapshot(readers)
      const sent: Sent[] = []
      const value = `Adversarial ${tag} outsider`
      const cellId = foreign.cellIds[0]
      const write = () => [event(outsider.username, foreign, cellId, "target.cell.commit", head(before, cellId), { value, ...lane })]
      const direct = await requestToken("outsider asks for the other project's sync token", outsider, foreign, sent)
      if (direct) await postEvents("outsider writes with that token", direct, write(), sent)
      const ownToken = await mintSyncToken(outsider.jwt, own.projectId, own.fileId)
      await postEvents("outsider writes to the other project with their own project's token", ownToken, write(), sent)
      const after = await readSnapshot(readers)
      const control = await ownerCommitLands(owner, foreign, cellId, head(after, cellId), value, lane)
      return { goal: "As a user with no role on a project, change one of its translations through the sync API, "
          + "first with a token requested for it and then with a token for a project the user owns.",
        outcome: probeOutcome(before, after, untouched, sent, control), sent,
        projects: [{ projectId: foreign.projectId, owner: owner.username }, { projectId: own.projectId, owner: outsider.username }] }
    },
  },
  {
    // One reviewer signing off the same translation twice must count once.
    id: "redteam.double-signoff", journey: "signoff",
    async run(run, tag) {
      const [reviewer] = run.sessions
      const { seeded } = await seedFixture(reviewer, { name: `adv redteam.double-signoff ${tag}`, orgId: run.orgId, members: [] })
      const readers = [{ projectId: seeded.projectId, reader: reviewer }]
      const lane = await readTargetLane(reviewer.jwt, seeded.projectId)
      const before = await readSnapshot(readers)
      const cellId = seeded.cellIds[2]
      const token = await mintSyncToken(reviewer.jwt, seeded.projectId, seeded.fileId)
      const sent: Sent[] = []
      const validate = () => [event(reviewer.username, seeded, cellId, "cell.validate", null, { editEventId: head(before, cellId), ...lane })]
      await postEvents("first sign-off", token, validate(), sent)
      await postEvents("second sign-off of the same translation", token, validate(), sent)
      await postEvents("two more sign-offs in one request", token, [...validate(), ...validate()], sent)
      const after = await readSnapshot(readers)
      // The control is the first sign-off: if it did not validate, the repeats tested nothing.
      const control = after.cells.find((cell) => cell.cellId === cellId && cell.side === "target")?.validated === true
      return { goal: "Sign off the same translation four times as one reviewer, through the sync API.",
        outcome: probeOutcome(before, after, { allowed: [{ kind: "validation", cellId }],
          required: [{ kind: "no-duplicate-validation", cellId }] }, sent, control), sent,
        projects: [{ projectId: seeded.projectId, owner: reviewer.username }] }
    },
  },
  {
    // A project always has a name: an empty or blank rename must be refused.
    id: "redteam.rename-to-empty", journey: "project-rename",
    async run(run, tag) {
      const [owner] = run.sessions
      const { seeded } = await seedFixture(owner, { name: `adv redteam.rename-to-empty ${tag}`, orgId: run.orgId, members: [] })
      const readers = [{ projectId: seeded.projectId, reader: owner }]
      const before = await readSnapshot(readers)
      const sent: Sent[] = []
      await renameProject("rename to an empty name", owner, seeded.projectId, "", sent)
      await renameProject("rename to a blank name", owner, seeded.projectId, "   ", sent)
      const after = await readSnapshot(readers)
      const renamed = `adv redteam.rename-to-empty ${tag} renamed`
      await renameProject("control", owner, seeded.projectId, renamed, [])
      const control = (await readSnapshot(readers)).projects[0]?.name === renamed
      return { goal: "As the project's owner, rename it to an empty name and to a blank one, through the identity API.",
        outcome: probeOutcome(before, after, { allowed: [], required: [{ kind: "project-name-nonempty", projectId: seeded.projectId }] }, sent, control),
        sent, projects: [{ projectId: seeded.projectId, owner: owner.username }] }
    },
  },
]
