import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  buildProjectWsUrl,
  createLinkUpstreamChangedHandler,
  createWsReconciler,
  fileInventoryChanged,
  isOwnWriteEcho,
  isValidationEvent,
  parseProjectWsMessage,
  type ProjectWsServerMessage,
} from "./ws-reconciler"
import {
  applyRemoteFrame,
  attachContextualRun,
  getContextualRunProgress,
  getContextualRunState,
  resetContextualRunStore,
} from "@/lib/contextual/run-store"

// ── Fake WebSocket harness ────────────────────────────────────────────────

interface FakeWsHandlers {
  onopen?: (this: WebSocket) => void
  onmessage?: (ev: MessageEvent) => void
  onclose?: (ev: CloseEvent) => void
  onerror?: (ev: Event) => void
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  url: string
  sent: string[] = []
  onopen: FakeWsHandlers["onopen"] | null = null
  onmessage: FakeWsHandlers["onmessage"] | null = null
  onclose: FakeWsHandlers["onclose"] | null = null
  onerror: FakeWsHandlers["onerror"] | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.call(this as unknown as WebSocket)
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("send called when not OPEN")
    }
    this.sent.push(data)
  }

  receive(payload: string): void {
    this.onmessage?.({ data: payload } as MessageEvent)
  }

  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason, wasClean: code === 1000 } as CloseEvent)
  }

  errorOnce(): void {
    this.onerror?.({} as Event)
  }
}

// Make the fake satisfy the typeof WebSocket constraint loosely.
const FakeWsCtor = FakeWebSocket as unknown as typeof WebSocket

describe("buildProjectWsUrl", () => {
  it("upgrades https → wss and embeds token", () => {
    expect(buildProjectWsUrl("https://example.com", "proj-1", "tok")).toBe(
      "wss://example.com/parties/project-sync/proj-1?token=tok",
    )
  })

  it("upgrades http → ws for local dev", () => {
    expect(buildProjectWsUrl("http://127.0.0.1:8787", "p", null)).toBe(
      "ws://127.0.0.1:8787/parties/project-sync/p",
    )
  })

  it("accepts ws:// / wss:// inputs unchanged", () => {
    expect(buildProjectWsUrl("ws://localhost", "p", null)).toBe(
      "ws://localhost/parties/project-sync/p",
    )
  })

  it("appends user param so dev ALLOW_UNAUTHENTICATED identity matches the client", () => {
    expect(buildProjectWsUrl("http://localhost", "p", null, "ryder")).toBe(
      "ws://localhost/parties/project-sync/p?user=ryder",
    )
    expect(buildProjectWsUrl("https://example.com", "p", "tok", "ry der")).toBe(
      "wss://example.com/parties/project-sync/p?token=tok&user=ry%20der",
    )
  })
})

describe("parseProjectWsMessage", () => {
  it("parses event.applied", () => {
    const msg = parseProjectWsMessage(
      JSON.stringify({
        t: "event.applied",
        id: "evt-1",
        kind: "target.cell.commit",
        project: "p",
        file: "f",
        cell: "c",
      }),
    )
    expect(msg).toEqual({
      t: "event.applied",
      id: "evt-1",
      kind: "target.cell.commit",
      project: "p",
      file: "f",
      cell: "c",
    })
  })

  it("passes `by` through on event.applied so own-write banner suppression can fire", () => {
    // ProjectWorkspace guards `msg.by === currentUsername` to avoid popping
    // the "changed elsewhere" banner when our own commit bounces back over
    // WS. Dropping `by` here turns every own edit into a phantom remote
    // change while the cell is still focused.
    const msg = parseProjectWsMessage(
      JSON.stringify({
        t: "event.applied",
        id: "evt-1",
        kind: "target.cell.commit",
        project: "p",
        cell: "c",
        by: "alice",
      }),
    )
    expect(msg).toMatchObject({ t: "event.applied", by: "alice" })
  })

  it("parses event.stale", () => {
    expect(
      parseProjectWsMessage(
        JSON.stringify({ t: "event.stale", id: "x", reason: "parent mismatch" }),
      ),
    ).toEqual({ t: "event.stale", id: "x", reason: "parent mismatch" })
  })

  it("parses member.removed (AQU-346 eject frame)", () => {
    // WHY: the DO sends this to a removed member right before closing their
    // socket. If the parser drops it (returns null), the workspace never
    // re-fetches the project and the removed user keeps an apparently-live
    // editor until token expiry — the exact bug AQU-346 fixes.
    expect(
      parseProjectWsMessage(
        JSON.stringify({ t: "member.removed", project: "p", userId: "bob" }),
      ),
    ).toEqual({ t: "member.removed", project: "p", userId: "bob" })
    // Malformed frames still reject.
    expect(
      parseProjectWsMessage(JSON.stringify({ t: "member.removed", project: "p" })),
    ).toBeNull()
  })

  it("parses project settings and bulk-import progress invalidations", () => {
    expect(
      parseProjectWsMessage(JSON.stringify({
        t: "project.settings.updated", project: "p1", version: 4,
      })),
    ).toEqual({ t: "project.settings.updated", project: "p1", version: 4 })
    expect(
      parseProjectWsMessage(JSON.stringify({
        t: "file.progress.updated", project: "p1", file: "f1", fileCreated: true,
      })),
    ).toEqual({ t: "file.progress.updated", project: "p1", file: "f1", fileCreated: true })
    expect(
      parseProjectWsMessage(JSON.stringify({
        t: "file.progress.updated", project: "p1", file: "f1",
      })),
    ).toBeNull()
  })

  it("parses presence", () => {
    const msg = parseProjectWsMessage(
      JSON.stringify({
        t: "presence",
        users: [
          {
            userId: "alice",
            focusedCell: "c1",
            currentFileId: "file-1",
            selection: { side: "target", anchor: 2, head: 5, draftText: "hello" },
            ts: 100,
          },
          { userId: "bob", ts: 200 },
        ],
      }),
    )
    expect(msg?.t).toBe("presence")
    if (msg?.t === "presence") {
      expect(msg.users).toHaveLength(2)
      expect(msg.users[0].focusedCell).toBe("c1")
      expect(msg.users[0].currentFileId).toBe("file-1")
      expect(msg.users[0].selection).toEqual({
        side: "target", anchor: 2, head: 5, draftText: "hello",
      })
      expect(msg.users[1].focusedCell).toBeUndefined()
    }
  })

  it("rejects oversized presence drafts", () => {
    expect(parseProjectWsMessage(JSON.stringify({
      t: "presence",
      users: [{
        userId: "alice",
        focusedCell: "c1",
        selection: { side: "target", anchor: 0, head: 0, draftText: "x".repeat(16_385) },
        ts: 100,
      }],
    }))).toBeNull()
  })

  it("parses lock.claimed + lock.released", () => {
    const claim = parseProjectWsMessage(
      JSON.stringify({ t: "lock.claimed", cellId: "c", by: { userId: "alice", ts: 7 } }),
    )
    expect(claim).toEqual({
      t: "lock.claimed",
      cellId: "c",
      by: { userId: "alice", ts: 7 },
    })
    const release = parseProjectWsMessage(
      JSON.stringify({ t: "lock.released", cellId: "c", by: { userId: "alice", ts: 9 } }),
    )
    expect(release?.t).toBe("lock.released")
  })

  it("returns null on malformed frames", () => {
    expect(parseProjectWsMessage("not json")).toBeNull()
    expect(parseProjectWsMessage(JSON.stringify({ t: "unknown" }))).toBeNull()
    expect(parseProjectWsMessage(JSON.stringify({ t: "event.applied", id: 1 }))).toBeNull()
    expect(parseProjectWsMessage(JSON.stringify({ t: "presence", users: "wrong" }))).toBeNull()
  })

  it("passes the worker's pausing frame through WebSocket parsing into the attached-file mirror", async () => {
    resetContextualRunStore()
    await attachContextualRun("p", "file-1")
    const msg = parseProjectWsMessage(JSON.stringify({
      t: "contextual.activity",
      project: "p",
      frame: {
        type: "contextual.run.state",
        runId: "01920000-0000-7000-8000-000000000001",
        fileId: "file-1",
        targetLang: "",
        status: "pausing",
        done: 4,
        total: 12,
        failed: 1,
      },
    }))

    expect(msg?.t).toBe("contextual.activity")
    if (msg?.t !== "contextual.activity" || msg.frame.type !== "contextual.run.state") {
      throw new Error("producer-shaped pausing frame was rejected")
    }
    applyRemoteFrame(msg.project, msg.frame)
    expect(getContextualRunState()).toMatchObject({ status: "pausing", fileId: "file-1" })
    expect(getContextualRunProgress()).toEqual({ done: 4, total: 12, failed: 1 })
  })

  it("keeps a newer project fan-out frame for another file out of the open-file mirror", async () => {
    resetContextualRunStore()
    await attachContextualRun("p", "file-open")
    const own = parseProjectWsMessage(JSON.stringify({
      t: "contextual.activity",
      project: "p",
      frame: {
        type: "contextual.run.state",
        runId: "01920000-0000-7000-8000-000000000001",
        fileId: "file-open",
        targetLang: "",
        status: "running",
        done: 2,
        total: 8,
        failed: 0,
      },
    }))
    const other = parseProjectWsMessage(JSON.stringify({
      t: "contextual.activity",
      project: "p",
      frame: {
        type: "contextual.run.state",
        runId: "01930000-0000-7000-8000-000000000002",
        fileId: "file-other",
        targetLang: "",
        status: "running",
        done: 7,
        total: 9,
        failed: 0,
      },
    }))
    if (own?.t !== "contextual.activity" || own.frame.type !== "contextual.run.state") {
      throw new Error("open-file producer frame was rejected")
    }
    if (other?.t !== "contextual.activity" || other.frame.type !== "contextual.run.state") {
      throw new Error("other-file producer frame was rejected")
    }

    applyRemoteFrame(own.project, own.frame)
    applyRemoteFrame(other.project, other.frame)

    expect(getContextualRunState()).toMatchObject({
      fileId: "file-open",
      runId: own.frame.runId,
      status: "running",
    })
    expect(getContextualRunProgress()).toEqual({ done: 2, total: 8, failed: 0 })
  })

  it("keeps a late project-A envelope out after project B attaches the same file id", async () => {
    resetContextualRunStore()
    await attachContextualRun("project-b", "shared-file")
    const lateA = parseProjectWsMessage(JSON.stringify({
      t: "contextual.activity",
      project: "project-a",
      frame: {
        type: "contextual.run.state",
        runId: "01930000-0000-7000-8000-000000000002",
        fileId: "shared-file",
        targetLang: "",
        status: "running",
        done: 7,
        total: 9,
      },
    }))
    if (lateA?.t !== "contextual.activity" || lateA.frame.type !== "contextual.run.state") {
      throw new Error("producer-shaped cross-project frame was rejected before store composition")
    }

    applyRemoteFrame(lateA.project, lateA.frame)

    expect(getContextualRunState()).toMatchObject({
      projectId: "project-b",
      fileId: "shared-file",
      runId: null,
      status: "idle",
    })
    expect(getContextualRunProgress()).toEqual({ done: 0, total: 0, failed: 0 })
  })

  it("parses link.upstream-changed (AQU-479 push accelerator)", () => {
    const msg = parseProjectWsMessage(
      JSON.stringify({
        t: "link.upstream-changed",
        project: "proj-down",
        upstream: "proj-up",
        untilSeq: 42,
        fileIds: ["f1", "f2"],
        cellIds: ["c1", "c2"],
      }),
    )
    expect(msg).toEqual({
      t: "link.upstream-changed",
      project: "proj-down",
      upstream: "proj-up",
      untilSeq: 42,
      fileIds: ["f1", "f2"],
      cellIds: ["c1", "c2"],
    })
  })

  it("returns null for a malformed link.upstream-changed frame", () => {
    expect(
      parseProjectWsMessage(
        JSON.stringify({ t: "link.upstream-changed", project: "p", upstream: "u" }),
      ),
    ).toBeNull()
    expect(
      parseProjectWsMessage(
        JSON.stringify({
          t: "link.upstream-changed",
          project: "p",
          upstream: "u",
          untilSeq: "not-a-number",
          fileIds: [],
          cellIds: [],
        }),
      ),
    ).toBeNull()
  })
})

describe("createWsReconciler", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("connects on next tick and emits onOpen", async () => {
    const onOpen = vi.fn()
    const r = createWsReconciler(
      {
        projectId: "p",
        baseUrl: "https://example.com",
        getToken: async () => "tok",
        webSocketCtor: FakeWsCtor,
      },
      { onOpen },
    )
    // queueMicrotask schedules connect; wait for it.
    await Promise.resolve()
    await Promise.resolve()
    const ws = FakeWebSocket.instances[0]
    expect(ws).toBeDefined()
    expect(ws.url).toContain("wss://example.com/parties/project-sync/p")
    expect(ws.url).toContain("token=tok")
    ws.open()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(r.isConnected()).toBe(true)
    r.close()
  })

  it("delivers parsed server frames to onMessage", async () => {
    const onMessage = vi.fn()
    const r = createWsReconciler(
      {
        projectId: "p",
        baseUrl: "https://example.com",
        getToken: async () => "tok",
        webSocketCtor: FakeWsCtor,
      },
      { onMessage },
    )
    await Promise.resolve()
    await Promise.resolve()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive(
      JSON.stringify({
        t: "event.applied",
        id: "e1",
        kind: "target.cell.commit",
        project: "p",
        file: "f",
        cell: "c",
      }),
    )
    expect(onMessage).toHaveBeenCalledTimes(1)
    const msg = onMessage.mock.calls[0][0] as ProjectWsServerMessage
    expect(msg.t).toBe("event.applied")
    if (msg.t === "event.applied") {
      expect(msg.id).toBe("e1")
      expect(msg.cell).toBe("c")
    }
    r.close()
  })

  it("emits onError when the server sends an unparseable frame", async () => {
    const onError = vi.fn()
    const r = createWsReconciler(
      {
        projectId: "p",
        baseUrl: "https://example.com",
        getToken: async () => "tok",
        webSocketCtor: FakeWsCtor,
      },
      { onError },
    )
    await Promise.resolve()
    await Promise.resolve()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive("not-json")
    expect(onError).toHaveBeenCalled()
    r.close()
  })

  it("send returns false when not OPEN", async () => {
    const r = createWsReconciler({
      projectId: "p",
      baseUrl: "https://example.com",
      getToken: async () => "tok",
      webSocketCtor: FakeWsCtor,
    })
    expect(
      r.send({ t: "focus.claim", cellId: "c", leaseMs: 30000 }),
    ).toBe(false)
    r.close()
  })

  it("send forwards a JSON-encoded frame when OPEN", async () => {
    const r = createWsReconciler({
      projectId: "p",
      baseUrl: "https://example.com",
      getToken: async () => "tok",
      webSocketCtor: FakeWsCtor,
    })
    await Promise.resolve()
    await Promise.resolve()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    expect(r.send({ t: "focus.claim", cellId: "c-1" })).toBe(true)
    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toEqual({ t: "focus.claim", cellId: "c-1" })
    r.close()
  })

  it("reconnects with backoff on close", async () => {
    vi.useFakeTimers()
    const r = createWsReconciler({
      projectId: "p",
      baseUrl: "https://example.com",
      getToken: async () => "tok",
      webSocketCtor: FakeWsCtor,
      minBackoffMs: 100,
      maxBackoffMs: 1_000,
    })
    // Initial connect is via queueMicrotask. Drain microtasks.
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].close(1006, "drop")
    // Backoff timer queued; advance to fire it.
    await vi.advanceTimersByTimeAsync(150)
    // Microtask drain inside reconnect path.
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2)
    r.close()
  })

  it("close() prevents further reconnects", async () => {
    vi.useFakeTimers()
    const r = createWsReconciler({
      projectId: "p",
      baseUrl: "https://example.com",
      getToken: async () => "tok",
      webSocketCtor: FakeWsCtor,
      minBackoffMs: 50,
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWebSocket.instances).toHaveLength(1)
    r.close()
    FakeWebSocket.instances[0].close(1006, "")
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe("isOwnWriteEcho", () => {
  // The server broadcasts every applied event back to its origin. The
  // committing handler already issued a targeted refetch after its outbox
  // flush, so the workspace must NOT refetch again on its own echo — that
  // doubles the GET (the in-flight coalescer misses it because the handler's
  // refetch is gated behind the flush and lands after this echo's fetch
  // cleared). This predicate is the guard; if it ever returns false for an
  // own write, the redundant double-fetch regresses.
  it("identifies an own-write echo (so the handler skips its redundant refetch)", () => {
    expect(isOwnWriteEcho({ by: "ryder" }, "ryder")).toBe(true)
  })

  it("treats another user's write as remote (the handler MUST refetch to learn it)", () => {
    expect(isOwnWriteEcho({ by: "alice" }, "ryder")).toBe(false)
  })

  it("treats a legacy frame with no `by` as remote — no regression vs pre-2c-γ servers", () => {
    // Older sync workers omit `by`; we can't attribute the write, so we must
    // keep refetching rather than risk silently dropping a real remote change.
    expect(isOwnWriteEcho({}, "ryder")).toBe(false)
    expect(isOwnWriteEcho({ by: "" }, "ryder")).toBe(false)
  })

  it("treats an Agent API commit as remote even when `by` is this user", () => {
    // An external agent commits an ask-mode changeset via the Agent API; the
    // sync-worker routes it through /events with a token minted for the
    // credential OWNER, so `by` is the owner's own username. If that owner has
    // the project open, NO outbox write happened in this client — suppressing
    // the echo would silently hide the agent's committed translation until a
    // manual reload. `via: "external"` must defeat the `by` match.
    expect(isOwnWriteEcho({ by: "ryder", via: "external" }, "ryder")).toBe(false)
  })

  it("`via: external` on another user's write stays remote (no accidental flip)", () => {
    expect(isOwnWriteEcho({ by: "alice", via: "external" }, "ryder")).toBe(false)
  })
})

describe("createLinkUpstreamChangedHandler (AQU-479 push accelerator)", () => {
  function frame(
    overrides: Partial<Extract<ProjectWsServerMessage, { t: "link.upstream-changed" }>> = {},
  ): Extract<ProjectWsServerMessage, { t: "link.upstream-changed" }> {
    return {
      t: "link.upstream-changed",
      project: "proj-down",
      upstream: "proj-up",
      untilSeq: 1,
      fileIds: ["f1"],
      cellIds: ["c1"],
      ...overrides,
    }
  }

  it("revalidates stale-source and triggers link/sync for the current project", () => {
    const revalidateStaleSource = vi.fn()
    const triggerLinkSync = vi.fn()
    const handle = createLinkUpstreamChangedHandler({
      currentProjectId: () => "proj-down",
      revalidateStaleSource,
      triggerLinkSync,
    })

    handle(frame())

    expect(revalidateStaleSource).toHaveBeenCalledTimes(1)
    expect(triggerLinkSync).toHaveBeenCalledTimes(1)
  })

  it("ignores a frame for a project the client isn't currently viewing", () => {
    // A stale reconciler (or a WS not yet torn down after navigating away)
    // must not trigger work for a project the user isn't looking at.
    const revalidateStaleSource = vi.fn()
    const triggerLinkSync = vi.fn()
    const handle = createLinkUpstreamChangedHandler({
      currentProjectId: () => "some-other-project",
      revalidateStaleSource,
      triggerLinkSync,
    })

    handle(frame({ project: "proj-down" }))

    expect(revalidateStaleSource).not.toHaveBeenCalled()
    expect(triggerLinkSync).not.toHaveBeenCalled()
  })

  it("ignores a frame when no project is open yet", () => {
    const revalidateStaleSource = vi.fn()
    const triggerLinkSync = vi.fn()
    const handle = createLinkUpstreamChangedHandler({
      currentProjectId: () => null,
      revalidateStaleSource,
      triggerLinkSync,
    })

    handle(frame())

    expect(revalidateStaleSource).not.toHaveBeenCalled()
    expect(triggerLinkSync).not.toHaveBeenCalled()
  })

  it("debounces link/sync triggers to one per window, but always revalidates staleness", () => {
    // Spec §8 / dispatch note: "Debounce (e.g. one sync per 5s per project)
    // so bursts don't hammer the route." A large upstream re-import can
    // produce many frames in quick succession; only the sync POST should
    // collapse — staleness must still reflect every frame immediately.
    let t = 0
    const revalidateStaleSource = vi.fn()
    const triggerLinkSync = vi.fn()
    const handle = createLinkUpstreamChangedHandler({
      currentProjectId: () => "proj-down",
      revalidateStaleSource,
      triggerLinkSync,
      debounceMs: 5000,
      now: () => t,
    })

    handle(frame()) // t=0 — fires
    t = 1000
    handle(frame()) // t=1000 — within window, suppressed
    t = 4999
    handle(frame()) // still within window, suppressed
    t = 5000
    handle(frame()) // window elapsed — fires again

    expect(revalidateStaleSource).toHaveBeenCalledTimes(4)
    expect(triggerLinkSync).toHaveBeenCalledTimes(2)
  })

  it("tracks debounce state per handler instance, not globally", () => {
    // Two open projects (or two mounts) must not share a debounce clock —
    // each ProjectWorkspace mount builds its own handler.
    const t = 0
    const syncA = vi.fn()
    const syncB = vi.fn()
    const handleA = createLinkUpstreamChangedHandler({
      currentProjectId: () => "proj-a",
      revalidateStaleSource: vi.fn(),
      triggerLinkSync: syncA,
      now: () => t,
    })
    const handleB = createLinkUpstreamChangedHandler({
      currentProjectId: () => "proj-b",
      revalidateStaleSource: vi.fn(),
      triggerLinkSync: syncB,
      now: () => t,
    })

    handleA(frame({ project: "proj-a" }))
    handleB(frame({ project: "proj-b" }))

    expect(syncA).toHaveBeenCalledTimes(1)
    expect(syncB).toHaveBeenCalledTimes(1)
  })
})

describe("isValidationEvent", () => {
  // Validation state (activeValidators → the pill's icon/color) projects into
  // the audit-stats read, not the /files/:fileId/cells row. When a REMOTE
  // user validates, the workspace's targeted revalidateCell alone leaves the
  // pill stale until the next full stats poll — the handler must also poke
  // revalidateCellStats for these kinds. If this predicate stops matching
  // them, that multi-user staleness window regresses (investigated under
  // FRO-348).
  it("matches cell.validate and cell.unvalidate (so remote validations refresh the pill)", () => {
    expect(isValidationEvent("cell.validate")).toBe(true)
    expect(isValidationEvent("cell.unvalidate")).toBe(true)
  })

  it("does not match other cell events — no extra stats GET per ordinary edit", () => {
    expect(isValidationEvent("target.cell.commit")).toBe(false)
    expect(isValidationEvent("source.cell.create")).toBe(false)
    expect(isValidationEvent("cell.audio.attach")).toBe(false)
    expect(isValidationEvent("file.create")).toBe(false)
  })
})

// AQU-744: staged imports create the file tombstoned and reveal it at
// finalize. A view whose file list was fetched during the staged window must
// treat a progress frame for an unknown file id as the reveal and re-pull the
// inventory — even when an older worker stamps the frame fileCreated: false.
describe("fileInventoryChanged (AQU-744 staged-import reveal)", () => {
  const frame = (file: string, fileCreated: boolean) => ({ file, fileCreated })

  it("refetches on the server's explicit inventory signal", () => {
    expect(fileInventoryChanged(frame("f1", true), new Set(["f1"]))).toBe(true)
    expect(fileInventoryChanged(frame("f-new", true), new Set())).toBe(true)
  })

  it("refetches when the frame names a file this client has never seen", () => {
    expect(fileInventoryChanged(frame("f-staged", false), new Set(["f-other"]))).toBe(true)
    expect(fileInventoryChanged(frame("f-staged", false), new Set())).toBe(true)
  })

  it("stays progress-only for a known file without the signal", () => {
    expect(fileInventoryChanged(frame("f1", false), new Set(["f1", "f2"]))).toBe(false)
  })
})
