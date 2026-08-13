/**
 * apply tests — staged agent events must go through the EXISTING write path
 * (enqueueEvent in events-emit.ts) authored by the current user, with the
 * server-staged ai provenance payload fields intact. These encode the
 * contract's safety story: the agent never gets its own write pipeline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { StagedEvent } from "./protocol"

vi.mock("@/lib/sync/events-emit", () => ({ enqueueEvent: vi.fn() }))

import { enqueueEvent } from "@/lib/sync/events-emit"
import { applyStagedEvent, applyStagedEvents, UnsupportedAgentEventError } from "./apply"

const mockEnqueue = vi.mocked(enqueueEvent)

const CTX = { projectId: "proj-1", author: "anna" }

function commitEvent(overrides: Partial<StagedEvent> = {}): StagedEvent {
  return {
    kind: "target.cell.commit",
    fileId: "f-1",
    cellId: "c-1",
    parentId: "evt-staged-parent",
    payload: {
      value: "drafted text",
      sourceEventId: "evt-src",
      ai_suggestion: true,
      agent_run_id: "run-1",
    },
    display: { canonicalRef: "MRK 4:1", before: "", after: "drafted text" },
    ...overrides,
  }
}

beforeEach(() => {
  mockEnqueue.mockReset()
  let n = 0
  mockEnqueue.mockImplementation((async (input: { kind: string }) => {
    n++
    return { event: { ...input, id: `evt-${n}` }, eventId: `evt-${n}` }
  }) as unknown as typeof enqueueEvent)
})

describe("applyStagedEvent — target.cell.commit", () => {
  it("enqueues through the normal write path with the ai payload fields intact", async () => {
    await applyStagedEvent(commitEvent(), CTX)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const input = mockEnqueue.mock.calls[0][0]
    expect(input.kind).toBe("target.cell.commit")
    expect(input.projectId).toBe("proj-1")
    expect(input.fileId).toBe("f-1")
    expect(input.cellId).toBe("c-1")
    expect(input.author).toBe("anna") // the USER, not the agent
    // Verbatim payload passthrough — provenance must survive Apply.
    expect(input.payload).toEqual({
      value: "drafted text",
      sourceEventId: "evt-src",
      ai_suggestion: true,
      agent_run_id: "run-1",
    })
  })

  it("prefers the live chain head over the staged parentId", async () => {
    await applyStagedEvent(commitEvent(), {
      ...CTX,
      resolveCell: () => ({ targetEventId: "evt-live-head", sourceEventId: "evt-src" }),
    })
    expect(mockEnqueue.mock.calls[0][0].parentId).toBe("evt-live-head")
  })

  it("falls back to the staged parentId, then the live source event id", async () => {
    await applyStagedEvent(commitEvent(), CTX)
    expect(mockEnqueue.mock.calls[0][0].parentId).toBe("evt-staged-parent")

    await applyStagedEvent(commitEvent({ parentId: undefined }), {
      ...CTX,
      resolveCell: () => ({ targetEventId: undefined, sourceEventId: "evt-src-genesis" }),
    })
    expect(mockEnqueue.mock.calls[1][0].parentId).toBe("evt-src-genesis")
  })

  it("rejects a commit without fileId/cellId", async () => {
    await expect(
      applyStagedEvent(commitEvent({ cellId: undefined }), CTX),
    ).rejects.toThrow(/fileId and cellId/)
  })
})

describe("applyStagedEvent — comment.create", () => {
  it("uses the sentinel fileId for project-scoped comments and fills commentId/scope", async () => {
    await applyStagedEvent(
      {
        kind: "comment.create",
        payload: { body: "Inconsistent rendering of 'lamp'." },
        display: {},
      },
      CTX,
    )
    const input = mockEnqueue.mock.calls[0][0]
    expect(input.fileId).toBe("__project__")
    expect(input.parentId).toBeNull()
    const payload = input.payload as {
      body: string
      commentId: string
      scope: unknown
      parentCommentId: unknown
    }
    expect(payload.body).toBe("Inconsistent rendering of 'lamp'.")
    expect(payload.commentId).toBeTruthy()
    expect(payload.scope).toEqual({ kind: "project" })
    expect(payload.parentCommentId).toBeNull()
  })

  it("builds a cell scope from the staged ids and keeps a server-staged scope verbatim", async () => {
    await applyStagedEvent(
      {
        kind: "comment.create",
        fileId: "f-1",
        cellId: "c-9",
        payload: { body: "check this" },
        display: { canonicalRef: "MRK 4:9" },
      },
      CTX,
    )
    expect((mockEnqueue.mock.calls[0][0].payload as { scope: unknown }).scope).toEqual({
      kind: "cell",
      fileId: "f-1",
      cellId: "c-9",
    })

    const stagedScope = { kind: "file", fileId: "f-1" }
    await applyStagedEvent(
      {
        kind: "comment.create",
        fileId: "f-1",
        payload: { body: "file note", scope: stagedScope, commentId: "cm-1" },
        display: {},
      },
      CTX,
    )
    const payload = mockEnqueue.mock.calls[1][0].payload as { scope: unknown; commentId: string }
    expect(payload.scope).toEqual(stagedScope)
    expect(payload.commentId).toBe("cm-1")
  })
})

describe("applyStagedEvent — cell.validate", () => {
  it("pins the staged editEventId, falling back to the live chain head", async () => {
    await applyStagedEvent(
      {
        kind: "cell.validate",
        fileId: "f-1",
        cellId: "c-1",
        payload: { editEventId: "evt-edit" },
        display: { canonicalRef: "MRK 4:1" },
      },
      CTX,
    )
    expect(mockEnqueue.mock.calls[0][0].payload).toEqual({ editEventId: "evt-edit" })
    expect(mockEnqueue.mock.calls[0][0].parentId).toBeNull()

    await applyStagedEvent(
      {
        kind: "cell.validate",
        fileId: "f-1",
        cellId: "c-1",
        payload: {},
        display: {},
      },
      { ...CTX, resolveCell: () => ({ targetEventId: "evt-live-head" }) },
    )
    expect(mockEnqueue.mock.calls[1][0].payload).toEqual({ editEventId: "evt-live-head" })
  })

  it("rejects when no editEventId can be resolved", async () => {
    await expect(
      applyStagedEvent(
        { kind: "cell.validate", fileId: "f-1", cellId: "c-1", payload: {}, display: {} },
        CTX,
      ),
    ).rejects.toThrow(/editEventId/)
  })
})

describe("applyStagedEvent — cell creates (AQU-890)", () => {
  function createEvent(overrides: Partial<StagedEvent> = {}): StagedEvent {
    return {
      kind: "source.cell.create",
      fileId: "f-1",
      cellId: "c-new",
      payload: {
        cellId: "c-new",
        anchorCellId: "c-1",
        value: "Section heading",
        type: "heading",
        ai_suggestion: true,
        agent_run_id: "run-1",
      },
      display: { after: "Section heading" },
      ...overrides,
    }
  }

  it("enqueues source.cell.create as a GENESIS event (parentId null) with provenance intact", async () => {
    await applyStagedEvent(createEvent(), CTX)
    const input = mockEnqueue.mock.calls[0][0]
    expect(input.kind).toBe("source.cell.create")
    expect(input.fileId).toBe("f-1")
    expect(input.cellId).toBe("c-new")
    expect(input.author).toBe("anna")
    // Genesis: isGenesisKind requires a null parent — a create must never
    // chain onto a neighbour's head or the projection rejects it.
    expect(input.parentId).toBeNull()
    expect(input.payload).toEqual({
      cellId: "c-new",
      anchorCellId: "c-1",
      value: "Section heading",
      type: "heading",
      ai_suggestion: true,
      agent_run_id: "run-1",
    })
  })

  it("enqueues target.cell.create the same way", async () => {
    await applyStagedEvent(
      createEvent({ kind: "target.cell.create", payload: { cellId: "c-new", value: "Título" } }),
      CTX,
    )
    const input = mockEnqueue.mock.calls[0][0]
    expect(input.kind).toBe("target.cell.create")
    expect(input.parentId).toBeNull()
    expect(input.payload).toEqual({ cellId: "c-new", value: "Título", anchorCellId: null })
  })

  it("defaults a missing anchorCellId to null (first row) rather than dropping the key", async () => {
    await applyStagedEvent(
      createEvent({ payload: { cellId: "c-new", value: "Heading" } }),
      CTX,
    )
    expect(mockEnqueue.mock.calls[0][0].payload).toMatchObject({ anchorCellId: null })
  })

  it("falls back to the envelope cellId when the payload omits it, and repeats it into the payload", async () => {
    await applyStagedEvent(
      createEvent({ cellId: "c-env", payload: { value: "Heading" } }),
      CTX,
    )
    const input = mockEnqueue.mock.calls[0][0]
    expect(input.cellId).toBe("c-env")
    // The projection reads the new row's id out of the PAYLOAD, so the two
    // must agree or the row lands under a different id than the card showed.
    expect(input.payload).toMatchObject({ cellId: "c-env" })
  })

  it("rejects a create with no cellId anywhere", async () => {
    await expect(
      applyStagedEvent(
        { kind: "source.cell.create", fileId: "f-1", payload: { value: "x" }, display: {} },
        CTX,
      ),
    ).rejects.toThrow(/needs fileId and cellId/)
  })

  it("rejects a create whose payload carries no string value", async () => {
    await expect(
      applyStagedEvent(createEvent({ payload: { cellId: "c-new" } }), CTX),
    ).rejects.toThrow(/needs a string value/)
  })
})

describe("applyStagedEvents", () => {
  it("chains successive commits to the SAME cell within one proposal", async () => {
    const ids = await applyStagedEvents(
      [commitEvent(), commitEvent({ payload: { value: "second draft", ai_suggestion: true } })],
      CTX,
    )
    expect(ids).toEqual(["evt-1", "evt-2"])
    // Second commit's parent must be the FIRST commit's freshly-minted id,
    // not the (now stale) staged parentId — otherwise the server sees a
    // losing sibling and dead-letters it.
    expect(mockEnqueue.mock.calls[1][0].parentId).toBe("evt-1")
  })

  it("chains a target commit onto a target create for the SAME new cell (AQU-890)", async () => {
    const ids = await applyStagedEvents(
      [
        {
          kind: "target.cell.create",
          fileId: "f-1",
          cellId: "c-new",
          payload: { cellId: "c-new", value: "" },
          display: {},
        },
        commitEvent({ cellId: "c-new", parentId: undefined, payload: { value: "drafted" } }),
      ],
      CTX,
    )
    expect(ids).toEqual(["evt-1", "evt-2"])
    expect(mockEnqueue.mock.calls[0][0].parentId).toBeNull()
    // The commit must chain onto the create it just minted — otherwise the
    // server sees a genesis sibling on an occupied slot.
    expect(mockEnqueue.mock.calls[1][0].parentId).toBe("evt-1")
  })

  it("gives a target commit its AD-9 source fallback from a source create in the same proposal", async () => {
    await applyStagedEvents(
      [
        {
          kind: "source.cell.create",
          fileId: "f-1",
          cellId: "c-new",
          payload: { cellId: "c-new", value: "Heading" },
          display: {},
        },
        commitEvent({ cellId: "c-new", parentId: undefined, payload: { value: "Título" } }),
      ],
      CTX,
    )
    // No target head exists, so the commit falls through to the source genesis
    // the previous event minted rather than enqueuing with a null parent.
    expect(mockEnqueue.mock.calls[1][0].parentId).toBe("evt-1")
  })

  it("throws UnsupportedAgentEventError for kinds the card cannot apply", async () => {
    await expect(
      applyStagedEvent(
        { kind: "assignment.create", payload: {}, display: {} },
        CTX,
      ),
    ).rejects.toBeInstanceOf(UnsupportedAgentEventError)
  })
})
