/**
 * session-store tests — the shared-session behaviors the two mounts rely on:
 * session-native wire shape (one user turn + sessionId), queueing instead of
 * dropping prompts sent mid-run, stop clearing the queue, and reset minting a
 * fresh server session.
 */

import { describe, it, expect, vi } from "vitest"
import {
  AgentSessionStore,
  localStoragePersistence,
  type AgentSendOptions,
  type PersistedSession,
  type SessionPersistence,
} from "./session-store"
import { createRun } from "./run-state"
import type { RunAgentOptions } from "./agent-client"

function sendOptions(text: string): AgentSendOptions {
  return { wire: text, display: text, jwt: "jwt", request: { projectId: "p1" } }
}

/** A runAgent fake the test resolves manually, capturing each call. */
function deferredRunAgent() {
  const calls: RunAgentOptions[] = []
  const resolvers: (() => void)[] = []
  const impl = vi.fn((options: RunAgentOptions) => {
    calls.push(options)
    return new Promise<void>((resolve) => resolvers.push(resolve))
  })
  return { impl, calls, finish: (i: number) => resolvers[i]() }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("AgentSessionStore", () => {
  it("sends session-native requests: sessionId + only the new user turn", async () => {
    const { impl, calls, finish } = deferredRunAgent()
    const store = new AgentSessionStore(impl)
    store.send(sendOptions("Draft GEN 1"))
    await flush()

    expect(calls).toHaveLength(1)
    expect(calls[0].request.sessionId).toBe(store.getState().sessionId)
    expect(calls[0].request.messages).toEqual([{ role: "user", content: "Draft GEN 1" }])
    expect(store.getState().isStreaming).toBe(true)

    calls[0].onFrame({ type: "assistant_delta", text: "ok" })
    calls[0].onFrame({ type: "done", runId: "r1", status: "ok" })
    finish(0)
    await flush()
    expect(store.getState().isStreaming).toBe(false)
    expect(store.getState().runs[0].status).toBe("ok")
  })

  it("queues prompts sent mid-run and dispatches them in order", async () => {
    const { impl, calls, finish } = deferredRunAgent()
    const store = new AgentSessionStore(impl)
    store.send(sendOptions("first"))
    await flush()
    store.send(sendOptions("second"))
    store.send(sendOptions("third"))

    expect(calls).toHaveLength(1) // second/third are waiting
    expect(store.getState().queued).toEqual(["second", "third"])

    finish(0)
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1].request.messages[0].content).toBe("second")
    expect(store.getState().queued).toEqual(["third"])

    finish(1)
    await flush()
    expect(calls).toHaveLength(3)
    expect(store.getState().queued).toEqual([])
    expect(store.getState().runs.map((r) => r.prompt)).toEqual(["first", "second", "third"])
  })

  it("stop aborts the in-flight run and drops the queue", async () => {
    const impl = vi.fn(
      (options: RunAgentOptions) =>
        new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("Agent run aborted", "AbortError")),
          )
        }),
    )
    const store = new AgentSessionStore(impl)
    store.send(sendOptions("long job"))
    await flush()
    store.send(sendOptions("follow-up"))
    expect(store.getState().queued).toEqual(["follow-up"])

    store.stop()
    await flush()
    expect(store.getState().queued).toEqual([])
    expect(impl).toHaveBeenCalledTimes(1) // the queued prompt never dispatched
    expect(store.getState().runs[0].status).toBe("error")
    expect(store.getState().runs[0].errorMessage).toBe("Stopped.")
  })

  it("reset clears runs and mints a new server session id", async () => {
    const { impl, calls, finish } = deferredRunAgent()
    const store = new AgentSessionStore(impl)
    const before = store.getState().sessionId
    store.send(sendOptions("hello"))
    await flush()
    finish(0)
    await flush()

    store.reset()
    const after = store.getState()
    expect(after.runs).toEqual([])
    expect(after.sessionId).not.toBe(before)

    store.send(sendOptions("fresh"))
    await flush()
    expect(calls[1].request.sessionId).toBe(after.sessionId)
  })

  it("a failed run surfaces its error and still releases the stream lock", async () => {
    const impl = vi.fn(() => Promise.reject(new Error("AI limit reached: Out of credits.")))
    const store = new AgentSessionStore(impl)
    store.send(sendOptions("draft"))
    await flush()
    expect(store.getState().isStreaming).toBe(false)
    expect(store.getState().runs[0]).toMatchObject({
      status: "error",
      errorMessage: "AI limit reached: Out of credits.",
    })
  })

  it("review decisions live on the session (survive workbench remounts) and reset with it", () => {
    const { impl } = deferredRunAgent()
    const store = new AgentSessionStore(impl)

    store.decide([["p1:c1", { outcome: "accepted", value: "text", appliedEventId: "e1" }]])
    store.decide([["p1:c2", { outcome: "rejected" }]])
    // A later decision on the same row wins (accept → undo).
    store.decide([["p1:c1", { outcome: "undone", value: "", appliedEventId: "e9" }]])

    const decided = store.getState().decided
    expect(decided.get("p1:c1")).toMatchObject({ outcome: "undone", appliedEventId: "e9" })
    expect(decided.get("p1:c2")).toMatchObject({ outcome: "rejected" })

    // New session = clean slate: stale decisions must not leak onto the
    // next conversation's proposals.
    store.reset()
    expect(store.getState().decided.size).toBe(0)
  })

  it("activity notes coalesce by key and ride the next send's wire only", async () => {
    const { impl, calls, finish } = deferredRunAgent()
    const store = new AgentSessionStore(impl)

    // Two notes for the same card — the later view supersedes; a second
    // card's note accumulates alongside.
    store.noteActivity("passage:a", "the user is looking at MRK 4 (target side)")
    store.noteActivity("passage:a", "the user is looking at MRK 5 (target side)")
    store.noteActivity("passage:b", "the user is looking at GEN 1 (source + target)")
    expect(store.getState().activity).toHaveLength(2)

    store.send(sendOptions("continue please"))
    await flush()
    const wire = calls[0].request.messages[0].content
    expect(wire).toContain("continue please")
    expect(wire).toContain("[user activity since your last reply]")
    expect(wire).not.toContain("MRK 4") // coalesced away
    expect(wire).toContain("MRK 5")
    expect(wire).toContain("GEN 1")
    // Drained — and the visible bubble stays what the user typed.
    expect(store.getState().activity).toHaveLength(0)
    expect(store.getState().runs[0].prompt).toBe("continue please")
    finish(0)
    await flush()

    // Nothing queued → the next wire carries no activity block.
    store.send(sendOptions("and again"))
    await flush()
    expect(calls[1].request.messages[0].content).not.toContain("[user activity")
  })

  it("activity notes clear on reset", () => {
    const { impl } = deferredRunAgent()
    const store = new AgentSessionStore(impl)
    store.noteActivity("passage:a", "stale note")
    store.reset()
    expect(store.getState().activity).toHaveLength(0)
  })
})

/**
 * Persistence (AQU-415): the agent conversation must survive a page reload —
 * chat already persisted, the agent did not. A fresh store (the reload) reads
 * the same persistence and rehydrates the transcript, sessionId, and review
 * decisions; transient stream state never persists; an interrupted run lands
 * terminal instead of a forever-spinner.
 */
describe("AgentSessionStore persistence", () => {
  /** In-memory persistence adapter with a peek at what was last written. */
  function memoryPersistence(initial: PersistedSession | null = null) {
    let saved = initial
    const persistence: SessionPersistence = {
      load: () => saved,
      save: (s) => {
        saved = s
      },
    }
    return { persistence, get: () => saved }
  }

  it("persists a settled conversation and a fresh store rehydrates it", async () => {
    const { impl, calls, finish } = deferredRunAgent()
    const mem = memoryPersistence()
    const store = new AgentSessionStore(impl, mem.persistence)
    const sessionId = store.getState().sessionId

    store.send(sendOptions("Draft GEN 1"))
    await flush()
    calls[0].onFrame({ type: "assistant_delta", text: "Dios" })
    calls[0].onFrame({ type: "done", runId: "r1", status: "ok" })
    finish(0)
    await flush()
    store.decide([["p1:c1", { outcome: "accepted", value: "Dios", appliedEventId: "e1" }]])

    // A brand-new store — the reload — reads the same persistence.
    const revived = new AgentSessionStore(impl, mem.persistence)
    const s = revived.getState()
    expect(s.sessionId).toBe(sessionId) // same server session → follow-ups continue it
    expect(s.runs).toHaveLength(1)
    expect(s.runs[0].prompt).toBe("Draft GEN 1")
    expect(s.runs[0].status).toBe("ok")
    expect(s.decided.get("p1:c1")).toMatchObject({ outcome: "accepted", appliedEventId: "e1" })
    expect(s.isStreaming).toBe(false)
  })

  it("does not persist mid-stream; flushes the final state when the run settles", async () => {
    const { impl, calls, finish } = deferredRunAgent()
    const mem = memoryPersistence()
    const store = new AgentSessionStore(impl, mem.persistence)

    store.send(sendOptions("hello"))
    await flush()
    calls[0].onFrame({ type: "assistant_delta", text: "partial" })
    expect(mem.get()).toBeNull() // still streaming → nothing written yet

    calls[0].onFrame({ type: "done", runId: "r1", status: "ok" })
    finish(0)
    await flush()
    expect(mem.get()?.runs).toHaveLength(1)
    expect(mem.get()?.runs[0].status).toBe("ok")
  })

  it("normalizes a run frozen mid-stream by the reload to a terminal error", () => {
    const running = createRun("draft")
    expect(running.status).toBe("running")
    const persisted: PersistedSession = {
      sessionId: "sess-1",
      runs: [running],
      decided: [],
      activity: [],
    }
    const store = new AgentSessionStore(vi.fn(), memoryPersistence(persisted).persistence)
    const run = store.getState().runs[0]
    expect(run.status).toBe("error")
    expect(run.errorMessage).toContain("reload")
  })

  it("reset persists a fresh empty session so no stale conversation returns after reload", async () => {
    const { impl, finish } = deferredRunAgent()
    const mem = memoryPersistence()
    const store = new AgentSessionStore(impl, mem.persistence)

    store.send(sendOptions("hello"))
    await flush()
    finish(0)
    await flush()
    expect(mem.get()?.runs).toHaveLength(1)

    store.reset()
    expect(mem.get()?.runs).toEqual([])
    const revived = new AgentSessionStore(impl, mem.persistence)
    expect(revived.getState().runs).toEqual([])
    expect(revived.getState().sessionId).toBe(store.getState().sessionId)
  })

  it("localStoragePersistence round-trips and isolates by project id", () => {
    const p = localStoragePersistence("proj-persist-test")
    expect(p.load()).toBeNull()

    const session: PersistedSession = {
      sessionId: "s9",
      runs: [],
      decided: [["k", { outcome: "rejected" }]],
      activity: [{ key: "a", note: "n" }],
    }
    p.save(session)
    expect(p.load()).toEqual(session)
    // A different project is a different bucket.
    expect(localStoragePersistence("proj-other-test").load()).toBeNull()
  })

  it("markMemoryReviewed/markBriefReviewed flip the matching notice across all runs (mem-M5)", async () => {
    const { impl, calls, finish } = deferredRunAgent()
    const store = new AgentSessionStore(impl)
    store.send(sendOptions("propose stuff"))
    await flush()
    calls[0].onFrame({ type: "memory.proposed", runId: "r1", memoryId: "m1", path: "a.md", preview: "a" })
    calls[0].onFrame({ type: "brief.proposed", runId: "r1", proposalId: "b1", preview: "b" })
    calls[0].onFrame({ type: "done", runId: "r1", status: "ok" })
    finish(0)
    await flush()

    store.markMemoryReviewed("m1")
    store.markBriefReviewed("b1")

    const [memoryItem, briefItem] = store.getState().runs[0].items
    expect(memoryItem).toMatchObject({ kind: "memory-proposed", status: "reviewed" })
    expect(briefItem).toMatchObject({ kind: "brief-proposed", status: "reviewed" })
  })
})
