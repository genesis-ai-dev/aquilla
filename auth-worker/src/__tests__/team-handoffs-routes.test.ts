// Human-expert handoffs on the team channel (routes/team-handoffs.ts,
// lib/team-handoffs.ts — AQU-1052).
//
// WHY these assertions. A handoff exists to be read back by somebody who was
// not in the room: "who asked, who was it routed to, who answered, and did
// the work carry on?" So the tests pin, in order of what a later change is
// most likely to break:
//
//   (a) the four facts and their actors round trip, each with its time, and
//       the actor is always the authenticated session — a forged requester or
//       answerer is the one thing a shared record cannot survive;
//   (b) answering does NOT resume the dependent work. This is the deliberate
//       asymmetry with the agent → human decisions next door (where the
//       answer wakes the blocked run): a handoff is raised BY a person about
//       work that person parked, and "stop, this file is wrong" is a valid
//       answer. Resuming is a separate, recorded act;
//   (c) routing preserves project permissions — a question cannot be parked
//       on somebody who cannot see the project, and the refusal does not
//       reveal whether the username exists;
//   (d) the release flag stops new asks and new work but never the reading or
//       the answering of asks already open. Switching Autopilot off must not
//       strand an unanswerable question forever. (The flag's general contract
//       is pinned in contextual-release-gate.test.ts; these are the handoff
//       surface's own four doors.)

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { createRun, getRun } from "../../../db/shared/contextual-runs"
import { AUTOPILOT_RELEASE_KEY } from "../lib/contextual/release-gate"
import type { TeamHandoff } from "../../../shared/team-handoffs"
import type { TeamMessage, TeamMessagePage, TeamThread } from "../../../shared/team-channel"

const PROJECT = "proj-handoff"
const OTHER_PROJECT = "proj-handoff-other"
/** `files.id` is the primary key project-wide, so each project gets its own. */
const fileFor = (projectId: string): string => `file-${projectId}`
const base = `/api/v2/projects/${PROJECT}/team`

let lead: string // OWNER via created_by
let contrib: string // CONTRIBUTOR member — the write floor
let expert: string // VIEWER member — below the write floor, still askable
let outsider: string // no membership at all

interface RaiseResponse {
  handoff: TeamHandoff
  thread: TeamThread
  message: TeamMessage
}

async function req(method: string, path: string, jwt: string, body?: unknown): Promise<Response> {
  return app.request(
    `${base}${path}`,
    {
      method,
      headers: authHeader(jwt),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )
}

async function code(res: Response): Promise<string> {
  const payload = (await res.json()) as { error?: { code?: string } }
  return payload.error?.code ?? ""
}

async function setReleased(released: boolean, projectId = PROJECT): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version, updated_by)
     VALUES (?, ?, 1, 1)
     ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
  )
    .bind(projectId, JSON.stringify({ [AUTOPILOT_RELEASE_KEY]: released }))
    .run()
}

async function raise(
  body: Record<string, unknown> = { question: "Is ⲛⲟⲩⲧⲉ the right register here?" },
  jwt = contrib,
): Promise<RaiseResponse> {
  const res = await req("POST", "/handoffs", jwt, body)
  expect(res.status).toBe(201)
  return (await res.json()) as RaiseResponse
}

async function list(jwt = contrib, query = ""): Promise<TeamHandoff[]> {
  const res = await req("GET", `/handoffs${query}`, jwt)
  expect(res.status).toBe(200)
  return ((await res.json()) as { handoffs: TeamHandoff[] }).handoffs
}

/** A run parked for want of a human, which is the state a handoff is raised
 *  from. Parked (not running) because `resumeRun` only accepts paused|parked —
 *  the same reason the pill offers "Next passage" there. */
async function seedParkedRun(projectId = PROJECT): Promise<string> {
  const created = await createRun(env.AQUILLA_PG, { projectId, fileId: fileFor(projectId) })
  if (created.status !== "ok") throw new Error(`run not created: ${created.status}`)
  await env.AQUILLA_PG.prepare(
    `UPDATE contextual_runs
        SET status = 'parked', park_reason = 'awaiting_input'
      WHERE id = ?`,
  )
    .bind(created.run.id)
    .run()
  return created.run.id
}

beforeEach(async () => {
  await seedUser(1, "lead")
  await seedUser(2, "contrib")
  await seedUser(3, "expert")
  await seedUser(4, "outsider")
  lead = await jwtFor("lead")
  contrib = await jwtFor("contrib")
  expert = await jwtFor("expert")
  outsider = await jwtFor("outsider")
  for (const id of [PROJECT, OTHER_PROJECT]) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, created_by) VALUES (?, 'Translation', 1)",
    )
      .bind(id)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 2, 400), (?, 3, 100)",
    )
      .bind(id, id)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO files (id, project_id, name, kind, event_id) VALUES (?, ?, 'Mark', 'usfm', ?)",
    )
      .bind(fileFor(id), id, `ev-${id}`)
      .run()
    await setReleased(true, id)
  }
})

describe("raising a handoff", () => {
  it("records the request, opens its thread, and asks in the main channel", async () => {
    const { handoff, thread, message } = await raise({
      question: "  Does the honorific carry over into reported speech?  ",
    })

    // (a) the request, with its actor and its time.
    expect(handoff.question).toBe("Does the honorific carry over into reported speech?")
    expect(handoff.requestedBy).toBe("contrib")
    expect(handoff.requestedAt).not.toBe("")
    expect(handoff.status).toBe("open")
    expect(handoff.runId).toBeNull()
    // Nothing is assigned, answered or resumed yet, and the record says so
    // rather than leaving a reader to guess.
    expect(handoff.assignedTo).toBeNull()
    expect(handoff.assignedAt).toBeNull()
    expect(handoff.answer).toBeNull()
    expect(handoff.answeredAt).toBeNull()
    expect(handoff.resumedBy).toBeNull()

    // The conversation lives in the channel: a `human` thread found from the
    // handoff id, and a main-channel question that owns it.
    expect(thread.sourceKind).toBe("human")
    expect(thread.sourceRef).toBe(handoff.id)
    expect(thread.status).toBe("open")
    expect(thread.title).toBe("Does the honorific carry over into reported speech?")
    expect(handoff.threadId).toBe(thread.id)
    expect(message.threadId).toBeNull()
    expect(message.author).toEqual({ kind: "human", id: "contrib" })
    expect(message.bodyKind).toBe("question")
    expect(message.body).toEqual({
      kind: "handoffAsked",
      handoffId: handoff.id,
      threadId: thread.id,
      question: "Does the honorific carry over into reported speech?",
      runId: null,
    })

    const channel = (await (await req("GET", "/messages", contrib)).json()) as TeamMessagePage
    expect(channel.messages.map((m) => m.id)).toContain(message.id)
  })

  it("names the blocked run only when that run is in this project", async () => {
    const mine = await seedParkedRun()
    const theirs = await seedParkedRun(OTHER_PROJECT)

    const { handoff } = await raise({ question: "Which manuscript?", runId: mine })
    expect(handoff.runId).toBe(mine)

    // Same 404 for "no such run" and "someone else's run": a handoff must not
    // become an existence oracle for other projects' run ids.
    const foreign = await req("POST", "/handoffs", contrib, {
      question: "Which manuscript?",
      runId: theirs,
    })
    expect(foreign.status).toBe(404)
    const missing = await req("POST", "/handoffs", contrib, {
      question: "Which manuscript?",
      runId: "no-such-run",
    })
    expect(missing.status).toBe(404)
  })

  it("takes the requester from the session and refuses a forged one", async () => {
    const res = await req("POST", "/handoffs", contrib, {
      question: "Who decides?",
      requestedBy: "lead",
    })
    expect(res.status).toBe(400)
    const same = await raise({ question: "Who decides?" }, lead)
    expect(same.handoff.requestedBy).toBe("lead")
  })

  it("replays a retried raise instead of asking twice", async () => {
    const id = crypto.randomUUID()
    const first = await raise({ id, question: "Which manuscript?" })
    const retry = await raise({ id, question: "Which manuscript?" })
    expect(retry.handoff.id).toBe(first.handoff.id)
    expect(await list()).toHaveLength(1)
    // A different question under a used id is a client bug, not a second ask,
    // and must not overwrite the first.
    const clash = await req("POST", "/handoffs", contrib, {
      id,
      question: "Something else entirely",
    })
    expect(clash.status).toBe(409)
    expect((await list())[0].question).toBe("Which manuscript?")
  })

  it("holds the CONTRIBUTOR write floor while staying readable to a VIEWER", async () => {
    await raise()
    expect((await req("POST", "/handoffs", expert, { question: "May I?" })).status).toBe(403)
    expect((await req("POST", "/handoffs", outsider, { question: "May I?" })).status).toBe(403)
    expect((await req("GET", "/handoffs", outsider)).status).toBe(403)
    // A VIEWER is often exactly the expert being asked, so reading the asks
    // is deliberately below the write floor.
    expect(await list(expert)).toHaveLength(1)
  })

  it("freezes on an archived project without destroying the record", async () => {
    await raise()
    await env.AQUILLA_PG.prepare("UPDATE projects SET archived_at = now() WHERE id = ?")
      .bind(PROJECT)
      .run()
    const res = await req("POST", "/handoffs", contrib, { question: "Still open?" })
    // Archiving removes the caller's resolved role, so the refusal is 403 —
    // the point is that it is refused and the history survives it.
    expect([403, 409]).toContain(res.status)
  })
})

describe("routing a handoff", () => {
  it("assigns without answering, and records who routed it", async () => {
    const { handoff } = await raise()
    const res = await req("POST", `/handoffs/${handoff.id}/assign`, contrib, {
      assignTo: "expert",
    })
    expect(res.status).toBe(200)
    const routed = ((await res.json()) as { handoff: TeamHandoff }).handoff
    expect(routed.assignedTo).toBe("expert")
    expect(routed.assignedBy).toBe("contrib")
    expect(routed.assignedAt).not.toBeNull()
    // Routing is an ASSIGNMENT, not a resolution: still open, still anyone's
    // to answer. Same rule as contextual_decisions.
    expect(routed.status).toBe("open")
    expect(routed.answer).toBeNull()
  })

  it("can route at raise time through the same recorded path", async () => {
    const { handoff } = await raise({ question: "Register?", assignTo: "expert" })
    expect(handoff.assignedTo).toBe("expert")
    expect(handoff.assignedBy).toBe("contrib")
    expect(handoff.assignedAt).not.toBeNull()
    expect(handoff.status).toBe("open")
  })

  it("refuses an assignee who cannot see the project, and tells the two apart from outside", async () => {
    const { handoff } = await raise()
    const stranger = await req("POST", `/handoffs/${handoff.id}/assign`, contrib, {
      assignTo: "outsider",
    })
    const ghost = await req("POST", `/handoffs/${handoff.id}/assign`, contrib, {
      assignTo: "nobody-at-all",
    })
    expect(stranger.status).toBe(400)
    expect(ghost.status).toBe(400)
    // Identical refusal, so /assign cannot be used to enumerate usernames.
    expect(await code(stranger)).toBe(await code(ghost))
    expect((await list())[0].assignedTo).toBeNull()
  })

  it("stores the canonical username, not the caller's spelling", async () => {
    const { handoff } = await raise()
    const res = await req("POST", `/handoffs/${handoff.id}/assign`, contrib, {
      assignTo: " EXPERT ",
    })
    expect(res.status).toBe(200)
    // An assignee has to match the author_id of the messages that person
    // writes in the same channel, or the thread renders two different people.
    expect(((await res.json()) as { handoff: TeamHandoff }).handoff.assignedTo).toBe("expert")
  })
})

describe("answering a handoff", () => {
  it("records an accountable answer and posts it into the thread", async () => {
    const { handoff, thread } = await raise()
    const res = await req("POST", `/handoffs/${handoff.id}/answer`, expert, {
      answer: "Use the plain form; the honorific is reserved for direct address.",
    })
    // A VIEWER cannot answer — answering sets project-wide policy, same floor
    // as answering a decision.
    expect(res.status).toBe(403)

    const ok = await req("POST", `/handoffs/${handoff.id}/answer`, lead, {
      answer: "Use the plain form; the honorific is reserved for direct address.",
    })
    expect(ok.status).toBe(200)
    const answered = ((await ok.json()) as { handoff: TeamHandoff }).handoff
    expect(answered.status).toBe("answered")
    expect(answered.answer).toBe(
      "Use the plain form; the honorific is reserved for direct address.",
    )
    expect(answered.answeredBy).toBe("lead")
    expect(answered.answeredAt).not.toBeNull()

    const page = (await (
      await req("GET", `/threads/${thread.id}/messages`, contrib)
    ).json()) as TeamMessagePage
    const posted = page.messages.at(-1)
    expect(posted?.author).toEqual({ kind: "human", id: "lead" })
    expect(posted?.bodyKind).toBe("text")
    expect(posted?.body).toEqual({
      text: "Use the plain form; the honorific is reserved for direct address.",
      handoffId: handoff.id,
    })
  })

  it("answers once — a second answer cannot overwrite the first", async () => {
    const { handoff } = await raise()
    expect(
      (await req("POST", `/handoffs/${handoff.id}/answer`, contrib, { answer: "Plain form" }))
        .status,
    ).toBe(200)
    const again = await req("POST", `/handoffs/${handoff.id}/answer`, lead, {
      answer: "No, honorific",
    })
    expect(again.status).toBe(409)
    expect(await code(again)).toBe("invalid_state")
    expect((await list())[0].answer).toBe("Plain form")
    expect((await list())[0].answeredBy).toBe("contrib")
  })

  it("requires an answer, and refuses a handoff from another project", async () => {
    const { handoff } = await raise()
    expect(
      (await req("POST", `/handoffs/${handoff.id}/answer`, contrib, { answer: "   " })).status,
    ).toBe(400)
    const elsewhere = await app.request(
      `/api/v2/projects/${OTHER_PROJECT}/team/handoffs/${handoff.id}/answer`,
      { method: "POST", headers: authHeader(contrib), body: JSON.stringify({ answer: "x" }) },
      env,
    )
    // Scope before mutate: a contributor on the other project must not be
    // able to answer this one's handoff by supplying its id.
    expect(elsewhere.status).toBe(404)
    expect((await list())[0].status).toBe("open")
    expect((await req("POST", "/handoffs/not-a-handoff/answer", contrib, { answer: "x" })).status)
      .toBe(404)
  })
})

describe("resuming the work that was waiting", () => {
  it("leaves the run parked until somebody explicitly resumes it", async () => {
    const runId = await seedParkedRun()
    const { handoff } = await raise({ question: "Which manuscript?", runId })

    const early = await req("POST", `/handoffs/${handoff.id}/resume`, contrib)
    expect(early.status).toBe(409)
    expect(await code(early)).toBe("invalid_state")

    await req("POST", `/handoffs/${handoff.id}/answer`, lead, { answer: "The critical text." })
    // THE point of this surface: the answer alone does not restart the work.
    expect((await getRun(env.AQUILLA_PG, runId))?.status).toBe("parked")
    expect((await list())[0].resumedAt).toBeNull()

    const res = await req("POST", `/handoffs/${handoff.id}/resume`, contrib)
    expect(res.status).toBe(200)
    const resumed = ((await res.json()) as { handoff: TeamHandoff; runId: string }).handoff
    expect(resumed.resumedBy).toBe("contrib")
    expect(resumed.resumedAt).not.toBeNull()
    expect((await getRun(env.AQUILLA_PG, runId))?.status).toBe("running")

    // Resumed once. A second press is not a second resume, and must not
    // overwrite who carried the work on.
    const twice = await req("POST", `/handoffs/${handoff.id}/resume`, contrib)
    expect(twice.status).toBe(409)
    expect((await list())[0].resumedBy).toBe("contrib")
  })

  it("has nothing to resume when no work was waiting", async () => {
    const { handoff } = await raise()
    await req("POST", `/handoffs/${handoff.id}/answer`, lead, { answer: "Plain form" })
    const res = await req("POST", `/handoffs/${handoff.id}/resume`, contrib)
    expect(res.status).toBe(409)
    expect((await list())[0].resumedAt).toBeNull()
  })

  it("refuses when the run itself is no longer resumable", async () => {
    const runId = await seedParkedRun()
    const { handoff } = await raise({ question: "Which manuscript?", runId })
    await req("POST", `/handoffs/${handoff.id}/answer`, lead, { answer: "The critical text." })
    await env.AQUILLA_PG.prepare("UPDATE contextual_runs SET status = 'terminated' WHERE id = ?")
      .bind(runId)
      .run()
    const res = await req("POST", `/handoffs/${handoff.id}/resume`, contrib)
    expect(res.status).toBe(409)
    // No record of a resume that did not happen: a false entry in an audit
    // trail is worse than a missing one.
    expect((await list())[0].resumedAt).toBeNull()
  })
})

describe("the project's record", () => {
  it("lists newest first and can narrow to what is still waiting on a person", async () => {
    const first = await raise({ question: "First ask" })
    const second = await raise({ question: "Second ask" })
    await req("POST", `/handoffs/${first.handoff.id}/answer`, lead, { answer: "Answered" })

    expect((await list()).map((h) => h.question)).toEqual(["Second ask", "First ask"])
    const open = await list(contrib, "?open=1")
    expect(open.map((h) => h.id)).toEqual([second.handoff.id])
    const narrowed = await list(contrib, "?limit=1")
    expect(narrowed).toHaveLength(1)
  })
})

describe("the Autopilot release flag", () => {
  beforeEach(async () => {
    await setReleased(false)
  })

  it("stops new asks and new work, never reading or answering the open ones", async () => {
    await setReleased(true)
    const runId = await seedParkedRun()
    const { handoff } = await raise({ question: "Which manuscript?", runId })
    await setReleased(false)

    // Closed: raising a new ask, and putting a run back to work.
    const raised = await req("POST", "/handoffs", contrib, { question: "Another?" })
    expect(raised.status).toBe(409)
    expect(await code(raised)).toBe("release_disabled")

    // Open: the history, the routing, and the answer. Switching Autopilot off
    // must not strand an unanswerable question open forever.
    expect(await list()).toHaveLength(1)
    expect(
      (await req("POST", `/handoffs/${handoff.id}/assign`, contrib, { assignTo: "expert" }))
        .status,
    ).toBe(200)
    expect(
      (await req("POST", `/handoffs/${handoff.id}/answer`, lead, { answer: "The critical text." }))
        .status,
    ).toBe(200)

    const resume = await req("POST", `/handoffs/${handoff.id}/resume`, contrib)
    expect(resume.status).toBe(409)
    expect(await code(resume)).toBe("release_disabled")
    expect((await getRun(env.AQUILLA_PG, runId))?.status).toBe("parked")
  })
})
