import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AgentDraftReview } from "./AgentDraftReview"
import {
  attachContextualDrafts, getContextualDrafts, hydrateContextualDrafts, resetContextualDraftsStore,
} from "@/lib/contextual/drafts-store"
import type { ContextualRunRecord } from "@/lib/contextual/transport"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { OutboxRawEvent } from "@/lib/sync/outbox-types"
import { peekOutboxBatch, removeOutboxEvents } from "@/lib/sync/outbox"
import * as outboxStore from "@/lib/sync/outbox"
import type { WsReconcilerHandlers } from "@/lib/sync/ws-reconciler"

const mocks = vi.hoisted(() => ({
  ws: {} as WsReconcilerHandlers,
  role: 700,
  revision: 1,
}))
vi.mock("@/lib/frontier/session-store", () => ({
  loadSession: vi.fn(async () => ({ jwt: "session-jwt", username: "alice" })),
  getSessionRevision: () => mocks.revision,
}))
vi.mock("@/lib/sync/ws-reconciler", () => ({
  createWsReconciler: vi.fn((_options, handlers: WsReconcilerHandlers) => {
    mocks.ws = handlers
    return { close: vi.fn(), send: vi.fn(), reconnect: vi.fn(), isConnected: () => true }
  }),
}))
// Namespace registration belongs to the integrating parent, not this slice.
// Keep the real translator and plural selection, adding only the new catalog.
vi.mock("@/lib/i18n/messages/en", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/i18n/messages/en")>()
  const { agentDraftReview } = await import("@/lib/i18n/namespaces/agentDraftReview")
  return { ...original, en: { ...original.en, ...agentDraftReview.keys } }
})
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }))

interface WireDraft {
  id: string
  runId: string
  cellId: string
  text: string
  provenance: { spanLabel: string }
}

const run: ContextualRunRecord = {
  runId: "run-1", fileId: "file-1", targetLang: "",
  status: "completed", phase: null, spanLabel: null, done: 11, total: 11,
  failed: 0, unitsSpent: 0, callsSpent: 0, lastError: null,
  createdAt: "2026-09-15T10:00:00Z", updatedAt: "2026-09-15T10:01:00Z",
  activeDirections: [],
}

let drafts: WireDraft[]
let rows: CellRow[]
let requests: { url: URL; body: unknown }[]
let posted: OutboxRawEvent[]
let rejectedPosts: unknown[]
let draftStatus: number
let reviewStatus: number
let activityStatus: number
let writeOutcome: "applied" | "offline" | "stale" | "rejected" | "staleSource"
let allowSelfValidation: boolean
let activeRun: ContextualRunRecord

function source(cellId: string, value = `Full source ${cellId}`): CellRow {
  return {
    cellId, side: "source", value, valueHtml: null, type: "text",
    canonicalRef: `GEN 1:${cellId.slice(1)}`, anchorCellId: null,
    eventId: `source-${cellId}`, sourceEventId: null, lastEditor: null,
    lastEditAt: 1, validated: false, wordCount: 4, targetLang: "",
  }
}

function seed(count = 3) {
  drafts = Array.from({ length: count }, (_, index) => ({
    id: `d${index + 1}`, runId: run.runId, cellId: `c${index + 1}`,
    text: `Suggestion ${index + 1}`, provenance: { spanLabel: "GEN 1:1–1:3" },
  }))
  rows = drafts.map((draft) => source(draft.cellId))
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
}

beforeEach(async () => {
  cleanup()
  await removeOutboxEvents((await peekOutboxBatch(10_000)).map((record) => record.id))
  resetContextualDraftsStore()
  mocks.role = 700
  mocks.revision = 1
  mocks.ws = {}
  activeRun = run
  draftStatus = reviewStatus = activityStatus = 200
  writeOutcome = "applied"
  allowSelfValidation = false
  requests = []
  posted = []
  rejectedPosts = []
  seed()
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ url, body })
    if (url.pathname.endsWith("/sync-token")) return json({
      token: "sync-jwt", expiresIn: 900, role: { level: mocks.role, name: "role", source: "org" },
    })
    if (url.pathname.endsWith("/settings")) return json({ version: 1, settings: { allowSelfValidation } })
    if (url.pathname.endsWith("/activity")) return json({
      run: { ...activeRun, id: activeRun.runId }, events: [], sceneBriefs: [], drafts: [],
      draftCounts: { proposed: drafts.filter((draft) => draft.runId === activeRun.runId).length, applied: 0, rejected: 0, superseded: 0 },
    }, activityStatus)
    if (url.pathname.endsWith("/contextual/drafts")) {
      return json(draftStatus === 200 ? { drafts } : { error: { message: "Draft request failed" } }, draftStatus)
    }
    if (url.pathname.endsWith("/review")) {
      rejectedPosts.push(body)
      if (reviewStatus !== 200) return json({ error: { message: "Review failed" } }, reviewStatus)
      const id = url.pathname.split("/").at(-2)
      drafts = drafts.filter((draft) => draft.id !== id)
      return json({ draft: { id, status: "rejected" } })
    }
    if (url.pathname.endsWith("/cells")) {
      const cellIds = url.searchParams.get("cellIds")?.split(",")
      const cells = cellIds
        ? cellIds.flatMap((id) => rows.filter((row) => row.cellId === id))
        : rows.filter((row) => !url.searchParams.get("side") || row.side === url.searchParams.get("side"))
      return json({ cells, nextCursor: null, total: cells.length })
    }
    if (url.pathname.endsWith(`/files/${activeRun.fileId}`)) return json({
      file: { fileId: activeRun.fileId, projectId: "project-1", name: "Genesis",
        fileType: "usfm", sourceLanguage: "en", targetLanguage: "es",
        cellCount: 3, approvedCount: 0, filledCount: 0, wordCount: 12, lastEditAt: null },
    })
    if (url.pathname.endsWith("/events")) {
      const events = body.events as OutboxRawEvent[]
      posted.push(...events)
      if (writeOutcome === "offline") throw new TypeError("offline")
      if (writeOutcome === "rejected") return json({
        accepted: [], rejected: events.map((event) => ({ id: event.id, status: 422, reason: "Invalid edit" })),
      })
      if (writeOutcome === "stale" || writeOutcome === "staleSource") return json({
        accepted: events.map((event) => ({ id: event.id })),
        [writeOutcome === "stale" ? "stale" : "staleSource"]: events.map((event) => ({
          id: event.id, reason: "source changed", currentSourceEventId: "new-source",
        })),
      })
      for (const event of events) {
        if (event.kind !== "target.cell.commit") continue
        const payload = event.payload as { value: string; valueHtml: string; sourceEventId: string; targetLang?: string }
        rows = rows.filter((row) => !(row.cellId === event.cellId && row.side === "target" && (row.targetLang ?? "") === (payload.targetLang ?? "")))
        rows.push({
          ...source(event.cellId!), side: "target", value: payload.value, valueHtml: payload.valueHtml,
          eventId: event.id, sourceEventId: payload.sourceEventId, targetLang: payload.targetLang ?? "",
        })
        drafts = drafts.filter((draft) => draft.cellId !== event.cellId)
      }
      return json({ accepted: events.map((event) => ({ id: event.id })), rejected: [] })
    }
    throw new Error(`Unexpected fetch ${url}`)
  }))
})

afterEach(async () => {
  cleanup()
  await removeOutboxEvents((await peekOutboxBatch(10_000)).map((record) => record.id))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function show(reviewRun = activeRun) {
  const onBack = vi.fn()
  const onReviewed = vi.fn()
  const view = render(<AgentDraftReview projectId="project-1" run={reviewRun} onBack={onBack} onReviewed={onReviewed} />)
  return { ...view, onBack, onReviewed }
}

async function loaded(text = "Suggestion 1") {
  await screen.findByText(text)
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled())
}

describe("AgentDraftReview", () => {
  it.each(["Genesis task", undefined])("keeps initial loading honest and hides opaque ids with fileName=%j", async (fileName) => {
    const fetchImpl = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void
    const deferred = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/contextual/drafts")) await deferred
      return fetchImpl(input, init)
    })
    render(<AgentDraftReview projectId="project-1" run={activeRun} fileName={fileName} onBack={vi.fn()} />)

    const review = screen.getByRole("region", { name: "Review task drafts" })
    expect(review).toHaveAttribute("aria-busy", "true")
    expect(screen.getByText(`${fileName ?? "Loading…"} · Project-default language`)).toBeInTheDocument()
    expect(review).not.toHaveTextContent(activeRun.fileId)
    expect(screen.queryByText("No pending drafts for this task")).not.toBeInTheDocument()
    expect(screen.queryByText(/pending drafts$/)).not.toBeInTheDocument()
    expect(screen.queryByText("Draft 1 of 3")).not.toBeInTheDocument()

    await act(async () => { release(); await deferred })
    await loaded()
    expect(review).toHaveAttribute("aria-busy", "false")
    expect(screen.getByText("Genesis · Project-default language")).toBeInTheDocument()
    expect(screen.getByText("Draft 1 of 3")).toBeInTheDocument()
    expect(screen.getByTestId("draft-review-source")).toHaveTextContent("Full source c1")
    expect(screen.getByRole("button", { name: "Use this translation" })).toBeEnabled()
  })

  it("passes real wire drafts through transport/store/card, focuses the first pending and preserves editor preferences", async () => {
    drafts.push({ id: "other", cellId: "c99", runId: "other-run", text: "Unrelated task", provenance: { spanLabel: "Elsewhere" } })
    localStorage.setItem("aquilla:editorLens:project-1", "audio")
    const { onBack } = show()
    await loaded()
    expect(screen.getByText("3 pending drafts")).toBeInTheDocument()
    expect(screen.getByText("Draft 1 of 3")).toBeInTheDocument()
    expect(screen.getByText("No saved translation yet.")).toBeInTheDocument()
    expect(screen.getByTestId("draft-review-source")).toHaveTextContent("Full source c1")
    expect(screen.queryByText("Unrelated task")).not.toBeInTheDocument()
    expect(getContextualDrafts().get("c1")).toMatchObject({
      draftId: "d1", runId: "run-1", targetLang: "", spanLabel: "GEN 1:1–1:3",
    })
    expect(screen.getByRole("button", { name: "Previous draft" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Next draft" }))
    expect(screen.getByTestId("draft-review-source")).toHaveTextContent("Full source c2")
    fireEvent.click(screen.getByRole("button", { name: "Previous draft" }))
    expect(screen.getByText("Draft 1 of 3")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }))
    expect(onBack).toHaveBeenCalledOnce()
    expect(localStorage.getItem("aquilla:editorLens:project-1")).toBe("audio")
  })

  it("distinguishes a stored translation from a pending suggestion, and shows the full media transcript", async () => {
    const transcript = "Full transcript, not an import filename. ".repeat(80)
    rows[0] = { ...rows[0], value: "clip.wav", medium: "media", transcription: transcript }
    rows.push({ ...source("c1"), side: "target", eventId: "saved-head", value: "Existing saved translation" })
    show()
    await loaded()
    expect(screen.getByTestId("draft-review-source").textContent).toBe(transcript)
    expect(screen.getByText("Existing saved translation")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Use this translation" })).toBeEnabled()
  })

  it("starts at the first document segment, not draft creation, UUID, or targeted-request order", async () => {
    drafts = [
      { id: "draft-a", runId: run.runId, cellId: "cell-a", text: "Suggestion GEN 1:6", provenance: { spanLabel: "GEN 1:5–1:7" } },
      { id: "draft-b", runId: run.runId, cellId: "cell-m", text: "Suggestion GEN 1:7", provenance: { spanLabel: "GEN 1:5–1:7" } },
      { id: "draft-z", runId: run.runId, cellId: "cell-z", text: "Suggestion GEN 1:5", provenance: { spanLabel: "GEN 1:5–1:7" } },
    ]
    // The authoritative full-file source endpoint walks z -> a -> m. A
    // targeted read deliberately returns the requested a -> m -> z order.
    rows = [
      { ...source("cell-z", "Source GEN 1:5"), canonicalRef: "GEN 1:5" },
      { ...source("cell-a", "Source GEN 1:6"), canonicalRef: "GEN 1:6", anchorCellId: "cell-z" },
      { ...source("cell-m", "Source GEN 1:7"), canonicalRef: "GEN 1:7", anchorCellId: "cell-a" },
    ]
    hydrateContextualDrafts(attachContextualDrafts("project-1", "file-1"), drafts.map((draft) => ({
      ...draft, draftId: draft.id,
    })))
    show()
    await loaded("Suggestion GEN 1:5")
    expect(screen.getByText("Draft 1 of 3")).toBeInTheDocument()
    expect(screen.getByTestId("draft-review-source")).toHaveTextContent("Source GEN 1:5")
    expect(requests.some(({ url }) => url.searchParams.get("side") === "source" && !url.searchParams.has("cellIds"))).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Next draft" }))
    expect(screen.getByText("Suggestion GEN 1:6")).toBeInTheDocument()

    act(() => {
      hydrateContextualDrafts(attachContextualDrafts("project-1", "file-1"), [...drafts].reverse().map((draft) => ({
        ...draft, draftId: draft.id,
      })))
    })
    expect(screen.getByText("Draft 2 of 3")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Previous draft" }))
    expect(screen.getByText("Suggestion GEN 1:5")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this suggestion" }))
    await screen.findByText("Suggestion GEN 1:6")
    expect(screen.getByText("Draft 1 of 2")).toBeInTheDocument()
  })

  it.each(["", "fr"])("accepts through the real outbox with the exact %j language lane, parent and source pin", async (lane) => {
    activeRun = { ...run, targetLang: lane }
    rows.push({ ...source("c1"), side: "target", targetLang: "de", value: "Sibling lane", eventId: "german-head" })
    if (lane) rows.push({ ...source("c1"), side: "target", targetLang: lane, value: "French stored", eventId: "french-head" })
    const { onReviewed } = show()
    await loaded()
    fireEvent.click(screen.getByRole("button", { name: "Use this translation" }))
    await screen.findByText("Suggestion 2")
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      kind: "target.cell.commit", projectId: "project-1", fileId: "file-1", cellId: "c1",
      parentId: lane ? "french-head" : "source-c1", author: "alice",
      payload: { value: "Suggestion 1", valueHtml: "Suggestion 1", sourceEventId: "source-c1", ...(lane ? { targetLang: lane } : {}) },
    })
    if (!lane) expect(posted[0].payload).not.toHaveProperty("targetLang")
    const draftRequests = requests.filter(({ url }) => url.pathname.endsWith("/contextual/drafts"))
    expect(draftRequests.every(({ url }) => url.searchParams.get("targetLang") === (lane || null))).toBe(true)
    const cellRequests = requests.filter(({ url }) => url.pathname.endsWith("/cells"))
    expect(cellRequests.every(({ url }) => url.searchParams.get("lane") === (lane || null))).toBe(true)
    expect(rejectedPosts).toEqual([])
    expect(await peekOutboxBatch(10)).toEqual([])
    expect(onReviewed).toHaveBeenCalledOnce()
    expect(screen.getByText("2 pending drafts")).toBeInTheDocument()
  })

  it("retains the current position through live updates and advances to the next remaining draft on rejection", async () => {
    const { onReviewed } = show()
    await loaded()
    fireEvent.click(screen.getByRole("button", { name: "Next draft" }))
    act(() => {
      hydrateContextualDrafts(attachContextualDrafts("project-1", "file-1"), [
        { draftId: "d0", runId: run.runId, cellId: "c0", text: "New arrival" },
        ...drafts.map((draft) => ({ ...draft, draftId: draft.id })),
      ])
    })
    expect(screen.getByText("Draft 2 of 4")).toBeInTheDocument()
    expect(screen.getByTestId("draft-review-source")).toHaveTextContent("Full source c2")
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this suggestion" }))
    await screen.findByText("Suggestion 3")
    expect(rejectedPosts).toEqual([{ action: "rejected" }])
    expect(posted).toEqual([])
    expect(onReviewed).toHaveBeenCalledOnce()
  })

  it.each([100, 300])("makes reader/reviewer role %i inspect-only", async (role) => {
    mocks.role = role
    show()
    await loaded()
    expect(screen.queryByRole("button", { name: "Use this translation" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Dismiss this suggestion" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Edit before accepting" })).not.toBeInTheDocument()
    expect(posted).toEqual([])
  })

  it("rechecks permissions at accept time before enqueue", async () => {
    show()
    await loaded()
    mocks.role = 300
    fireEvent.click(screen.getByRole("button", { name: "Use this translation" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Contributor access")
    expect(posted).toEqual([])
    expect(await peekOutboxBatch(10)).toEqual([])
  })

  it("keeps edits local until acceptance without mutating run or draft ownership", async () => {
    show()
    await loaded()
    fireEvent.click(screen.getByRole("button", { name: "Edit before accepting" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Your version of the suggestion" }), { target: { value: "Human revised text" } })
    fireEvent.click(screen.getByRole("button", { name: "Next draft" }))
    fireEvent.click(screen.getByRole("button", { name: "Previous draft" }))
    expect(screen.getByRole("textbox")).toHaveValue("Human revised text")
    expect(posted).toEqual([])
    expect(getContextualDrafts().get("c1")?.text).toBe("Suggestion 1")
    fireEvent.click(screen.getByRole("button", { name: "Accept edited translation" }))
    await screen.findByText("Suggestion 2")
    expect(posted[0].payload).toMatchObject({ value: "Human revised text" })
    expect(requests.some(({ url }) => /pause|resume|steering|terminate/.test(url.pathname))).toBe(false)
    expect(rejectedPosts).toEqual([])
  })

  it("honors self-validation settings through the existing validation emitter", async () => {
    allowSelfValidation = true
    show()
    await loaded()
    fireEvent.click(screen.getByRole("button", { name: "Use this translation" }))
    await screen.findByText("Suggestion 2")
    expect(posted.map((event) => event.kind)).toEqual(["target.cell.commit", "cell.validate"])
    expect(posted[1].payload).toMatchObject({ editEventId: posted[0].id })
  })

  it.each(["source", "target", "proposal"])("fails closed when the %s changed after review", async (changed) => {
    show()
    await loaded()
    if (changed === "source") rows[0].eventId = "changed-source"
    if (changed === "target") rows.push({ ...source("c1"), side: "target", eventId: "new-target" })
    if (changed === "proposal") drafts[0].text = "Replacement suggestion"
    fireEvent.click(screen.getByRole("button", { name: "Use this translation" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("changed")
    expect(posted).toEqual([])
    expect(await peekOutboxBatch(10)).toEqual([])
  })

  it.each(["stale", "staleSource", "rejected"] as const)("does not call acceptance saved when the server returns %s", async (outcome) => {
    writeOutcome = outcome
    const { onReviewed } = show()
    await loaded()
    fireEvent.click(screen.getByRole("button", { name: "Use this translation" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not finish accepting")
    expect(screen.getByText("Suggestion 1")).toBeInTheDocument()
    expect(onReviewed).not.toHaveBeenCalled()
    expect(rejectedPosts).toEqual([])
  })

  it("retries an offline upload using the same durable event, not a second commit", async () => {
    writeOutcome = "offline"
    show()
    await loaded()
    fireEvent.click(screen.getByRole("button", { name: "Use this translation" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("queued")
    const id = posted[0].id
    expect(await peekOutboxBatch(10)).toHaveLength(1)
    writeOutcome = "applied"
    fireEvent.click(screen.getByRole("button", { name: "Retry sync" }))
    await screen.findByText("Suggestion 2")
    expect(posted.map((event) => event.id)).toEqual([id, id])
  })

  it("surfaces durable-enqueue failures without pretending the proposal was accepted", async () => {
    const { onReviewed } = show()
    await loaded()
    vi.spyOn(outboxStore, "enqueueOutboxEvent").mockRejectedValueOnce(new Error("IndexedDB quota exceeded"))
    fireEvent.click(screen.getByRole("button", { name: "Use this translation" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("IndexedDB quota exceeded")
    expect(onReviewed).not.toHaveBeenCalled()
    expect(posted).toEqual([])
    expect(screen.getByText("3 pending drafts")).toBeInTheDocument()
  })

  it("does not relabel an older queued edit as the newly signed-in user's acceptance", async () => {
    writeOutcome = "offline"
    show()
    await loaded()
    fireEvent.click(screen.getByRole("button", { name: "Use this translation" }))
    await screen.findByRole("alert")
    mocks.revision += 1
    writeOutcome = "applied"
    fireEvent.click(screen.getByRole("button", { name: "Retry sync" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("changed"))
    expect(posted).toHaveLength(1)
  })

  it("shows a failed dismissal without removing the pending proposal", async () => {
    reviewStatus = 503
    show()
    await loaded()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this suggestion" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn’t be dismissed")
    expect(screen.getByText("3 pending drafts")).toBeInTheDocument()
    reviewStatus = 200
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this suggestion" }))
    await screen.findByText("Suggestion 2")
  })

  it("does not turn a failed request or unavailable backend into an empty result", async () => {
    draftStatus = 503
    show()
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load")
    expect(screen.queryByText("No pending drafts for this task")).not.toBeInTheDocument()
    draftStatus = 200
    activityStatus = 404
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not available"))
    expect(screen.queryByText("No pending drafts for this task")).not.toBeInTheDocument()
  })

  it("never calls an unavailable draft list empty while this task still has proposed output", async () => {
    draftStatus = 404
    show()
    expect(await screen.findByRole("alert")).toHaveTextContent("not available")
    expect(screen.queryByText("No pending drafts for this task")).not.toBeInTheDocument()
  })

  it("discards an old task's delayed load after switching to another task", async () => {
    const fetchImpl = vi.mocked(fetch).getMockImplementation()!
    let release!: (response: Response) => void
    const deferred = new Promise<Response>((resolve) => { release = resolve })
    const oldRows = drafts.map((draft) => ({ ...draft }))
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/contextual/drafts") && activeRun.runId === "run-1") return deferred
      return fetchImpl(input, init)
    })
    const view = show()
    await waitFor(() => expect(requests.some(({ url }) => url.pathname.endsWith("/activity"))).toBe(true))
    activeRun = { ...run, runId: "run-2" }
    drafts = [{ ...drafts[0], runId: "run-2", id: "new-draft", text: "Second task draft" }]
    view.rerender(<AgentDraftReview projectId="project-1" run={activeRun} onBack={view.onBack} />)
    await loaded("Second task draft")
    await act(async () => { release(json({ drafts: oldRows })); await deferred })
    expect(screen.getByText("Second task draft")).toBeInTheDocument()
    expect(screen.queryByText("Suggestion 1")).not.toBeInTheDocument()
    expect(getContextualDrafts().get("c1")?.runId).toBe("run-2")
  })

  it("renders authoritative empty state and unavailable source explicitly", async () => {
    drafts = []
    const view = show()
    await screen.findByText("No pending drafts for this task")
    view.unmount()
    seed(1)
    rows = []
    show()
    await loaded()
    expect(screen.getByRole("alert")).toHaveTextContent("source for this suggestion is unavailable")
    expect(screen.queryByRole("button", { name: "Use this translation" })).not.toBeInTheDocument()
  })

  it("observes lane-qualified focus leases before allowing any decision", async () => {
    activeRun = { ...run, targetLang: "fr" }
    show()
    await loaded()
    act(() => { mocks.ws.onMessage?.({ t: "lock.claimed", cellId: "c1@lane:de", by: { userId: "bob", ts: 1 } }) })
    expect(screen.getByRole("button", { name: "Use this translation" })).toBeEnabled()
    act(() => { mocks.ws.onMessage?.({ t: "lock.claimed", cellId: "c1@lane:fr", by: { userId: "bob", ts: 1 } }) })
    expect(screen.queryByRole("button", { name: "Use this translation" })).not.toBeInTheDocument()
    expect(screen.getByText("Another contributor is editing this segment.")).toBeInTheDocument()
    act(() => { mocks.ws.onMessage?.({ t: "lock.released", cellId: "c1@lane:fr", by: { userId: "bob", ts: 1 } }) })
    expect(screen.getByRole("button", { name: "Use this translation" })).toBeEnabled()
  })
})
