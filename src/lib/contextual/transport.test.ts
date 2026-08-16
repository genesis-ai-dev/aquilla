/**
 * transport.test.ts — fetch-client contract tests for the contextual run
 * transport (slice D2). The auth-worker routes are being built in a parallel
 * slice, so these tests pin the CLIENT side of the contract: URL, method,
 * Authorization header, body shape, and typed-error mapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/frontier/session-store", () => ({
  loadSession: vi.fn(async () => ({ jwt: "jwt-token", username: "alice" })),
}))

import { loadSession } from "@/lib/frontier/session-store"
import {
  ContextualApiError,
  ContextualAuthError,
  commandContextualRun,
  fetchContextualDrafts,
  fetchContextualOverview,
  fetchContextualRunActivity,
  fetchContextualRuns,
  installContextualTransport,
  realContextualTransport,
  resetContextualTransportForTesting,
  sendContextualSteering,
  startProjectContextualRun,
} from "./transport"
import {
  getContextualRunState,
  resetContextualRunStore,
  startContextualRun,
  type ContextualRunSnapshot,
} from "./run-store"

const PROJECT_ID = "proj/1" // contains a slash — must be URI-encoded in paths
const FILE_ID = "file 1" // contains a space — must be URI-encoded in queries

const RUN: ContextualRunSnapshot = {
  runId: "0198c0de-0000-7000-8000-000000000001",
  fileId: FILE_ID,
  status: "running",
  phase: "Drafting…",
  spanLabel: "LUK 1:1–1:8",
  done: 3,
  total: 12,
  failed: 0,
  activeDirections: ["Keep the tone formal"],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  resetContextualTransportForTesting()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(loadSession).mockResolvedValue(
    { jwt: "jwt-token", username: "alice" } as Awaited<ReturnType<typeof loadSession>>,
  )
  resetContextualTransportForTesting()
  resetContextualRunStore()
})

function lastRequest(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1)
  if (!call) throw new Error("no fetch call recorded")
  return { url: call[0] as string, init: call[1] as RequestInit }
}

describe("fetchContextualDrafts", () => {
  it("retains each owning run id for the multi-run review backlog", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      drafts: [{
        id: "draft-1",
        runId: "older-owning-run",
        cellId: "cell-1",
        text: "Review me",
        provenance: { spanId: "span-1" },
      }],
    }))

    await expect(fetchContextualDrafts(PROJECT_ID, FILE_ID)).resolves.toEqual([{
      draftId: "draft-1",
      runId: "older-owning-run",
      cellId: "cell-1",
      text: "Review me",
      spanLabel: "span-1",
    }])
    expect(lastRequest().url).toContain("/contextual/drafts?fileId=file%201&status=proposed")
  })
})

describe("fetchSnapshot", () => {
  it("GETs /contextual/runs?fileId= with the JWT and reports an available run", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ run: RUN }))
    const snap = await realContextualTransport.fetchSnapshot(PROJECT_ID, FILE_ID)
    const { url, init } = lastRequest()
    // Base-URL agnostic (VITE_AUTH_BASE varies by env) — pin the path + query.
    expect(url).toContain("/api/v2/projects/proj%2F1/contextual/runs?fileId=file%201")
    expect(init.method).toBeUndefined() // GET
    expect(init.headers).toMatchObject({ Authorization: "Bearer jwt-token" })
    expect(snap).toEqual({ available: true, run: RUN })
  })

  it("maps 404/501 to { available: false } instead of throwing (backend not deployed)", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }))
    expect(await realContextualTransport.fetchSnapshot(PROJECT_ID, FILE_ID)).toEqual({ available: false })
    fetchMock.mockResolvedValue(new Response("nope", { status: 501 }))
    expect(await realContextualTransport.fetchSnapshot(PROJECT_ID, FILE_ID)).toEqual({ available: false })
  })

  it("reports { available: true, run: null } when no run exists for the file", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ run: null }))
    expect(await realContextualTransport.fetchSnapshot(PROJECT_ID, FILE_ID)).toEqual({
      available: true,
      run: null,
    })
  })

  it("throws ContextualApiError with the server message on other failures", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "quota exceeded" } }, 429))
    const err = await realContextualTransport.fetchSnapshot(PROJECT_ID, FILE_ID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContextualApiError)
    expect((err as ContextualApiError).status).toBe(429)
    expect((err as ContextualApiError).message).toContain("quota exceeded")
  })

  it("throws ContextualAuthError when there is no session", async () => {
    vi.mocked(loadSession).mockResolvedValue(null)
    await expect(realContextualTransport.fetchSnapshot(PROJECT_ID, FILE_ID))
      .rejects.toBeInstanceOf(ContextualAuthError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("start + run commands", () => {
  it("POSTs /runs with { fileId } and remembers the run's project for later commands", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ runId: RUN.runId }))
    const { runId } = await realContextualTransport.start(PROJECT_ID, FILE_ID)
    expect(runId).toBe(RUN.runId)
    const startReq = lastRequest()
    expect(startReq.url).toContain("/api/v2/projects/proj%2F1/contextual/runs")
    expect(startReq.init.method).toBe("POST")
    expect(JSON.parse(startReq.init.body as string)).toEqual({ fileId: FILE_ID })

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await realContextualTransport.pause(runId)
    expect(lastRequest().url).toContain(
      `/api/v2/projects/proj%2F1/contextual/runs/${RUN.runId}/pause`,
    )
    expect(lastRequest().init.method).toBe("POST")

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await realContextualTransport.resume(runId)
    expect(lastRequest().url).toContain(`/runs/${RUN.runId}/resume`)

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await realContextualTransport.terminate(runId)
    expect(lastRequest().url).toContain(`/runs/${RUN.runId}/terminate`)
  })

  it("learns a run's project from fetchSnapshot too (reload → pause without start)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ run: RUN }))
    await realContextualTransport.fetchSnapshot(PROJECT_ID, FILE_ID)
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await realContextualTransport.pause(RUN.runId)
    expect(lastRequest().url).toContain("/projects/proj%2F1/contextual/runs/")
  })

  it("rejects commands for a runId it has never seen", async () => {
    const err = await realContextualTransport.pause("unknown-run").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContextualApiError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("maps a failed command to ContextualApiError with status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ runId: RUN.runId }))
    await realContextualTransport.start(PROJECT_ID, FILE_ID)
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "run already finished" } }, 409))
    const err = await realContextualTransport.pause(RUN.runId).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContextualApiError)
    expect((err as ContextualApiError).status).toBe(409)
  })
})

describe("steering", () => {
  it("POSTs the project-scoped steering route with kind/body/runId", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ runId: RUN.runId }))
    await realContextualTransport.start(PROJECT_ID, FILE_ID)
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await sendContextualSteering(RUN.runId, "Prefer shorter sentences")
    const { url, init } = lastRequest()
    expect(url).toContain(`/projects/${encodeURIComponent(PROJECT_ID)}/contextual/steering`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "direction",
      body: "Prefer shorter sentences",
      runId: RUN.runId,
    })
  })
})

describe("project Autopilot observability", () => {
  it("GETs the overview contract and marks a successful response available", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      files: [], activeRuns: 0, doneSpans: 3, totalSpans: 8, failedSpans: 0,
      unitsSpent: 14, proposedDrafts: 2, appliedDrafts: 1,
    }))
    const result = await fetchContextualOverview(PROJECT_ID)
    expect(lastRequest().url).toContain("/projects/proj%2F1/contextual/overview")
    expect(lastRequest().init.headers).toMatchObject({ Authorization: "Bearer jwt-token" })
    expect(result).toMatchObject({ available: true, doneSpans: 3, proposedDrafts: 2 })
  })

  it("POSTs the project-wide start contract and preserves mixed results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      scope: "project",
      scopeGroup: "scope-1",
      started: [{ runId: RUN.runId, fileId: FILE_ID }],
      skipped: [{ fileId: "other", reason: "already running" }],
      totalCandidates: 2,
      deferred: { count: 1, reason: "batch_limit" },
      truncated: true,
    }, 201))
    const result = await startProjectContextualRun(PROJECT_ID)
    const request = lastRequest()
    expect(request.url).toContain("/projects/proj%2F1/contextual/runs")
    expect(request.init.method).toBe("POST")
    expect(JSON.parse(request.init.body as string)).toEqual({ scope: "project" })
    expect(result).toMatchObject({
      scope: "project",
      scopeGroup: "scope-1",
      started: [{ runId: RUN.runId }],
      skipped: [{ reason: "already running" }],
      totalCandidates: 2,
      deferred: { count: 1, reason: "batch_limit" },
      truncated: true,
    })
  })

  it("lists and normalizes durable run history", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      available: true,
      runs: [{
        id: RUN.runId,
        fileId: FILE_ID,
        status: "paused",
        doneSpans: 5,
        totalSpans: 12,
        failedSpans: 1,
        callsSpent: 9,
        unitsSpent: 44,
        proposedDrafts: 3,
        lastError: null,
        createdAt: "2026-08-11T10:00:00.000Z",
        updatedAt: "2026-08-11T10:05:00.000Z",
      }],
      truncated: true,
      nextCursor: {
        createdAt: "2026-08-11T10:00:00.000Z",
        runId: RUN.runId,
      },
    }))
    const page = await fetchContextualRuns(PROJECT_ID)
    expect(lastRequest().url).toContain("/projects/proj%2F1/contextual/runs")
    expect(lastRequest().init.method).toBeUndefined()
    expect(page).toMatchObject({
      available: true,
      truncated: true,
      nextCursor: {
        createdAt: "2026-08-11T10:00:00.000Z",
        runId: RUN.runId,
      },
    })
    expect(page.runs[0]).toMatchObject({
      runId: RUN.runId,
      status: "paused",
      done: 5,
      total: 12,
      failed: 1,
      callsSpent: 9,
      proposedDrafts: 3,
    })
  })

  it("requests an older run-history page with the backend keyset cursor", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      available: true,
      runs: [],
      truncated: false,
      nextCursor: null,
    }))
    await fetchContextualRuns(PROJECT_ID, {
      cursor: {
        createdAt: "2026-08-11T09:00:00.000Z",
        runId: "older/run",
      },
      proposedOnly: true,
    })

    const url = new URL(lastRequest().url)
    expect(url.searchParams.get("beforeCreatedAt")).toBe("2026-08-11T09:00:00.000Z")
    expect(url.searchParams.get("beforeRunId")).toBe("older/run")
    expect(url.searchParams.get("proposedOnly")).toBe("true")
  })

  it("GETs one run's activity and keeps evidence records available", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      run: { ...RUN, callsSpent: 7, unitsSpent: 30, lastError: null, createdAt: "2026-08-11T10:00:00.000Z", updatedAt: "2026-08-11T10:02:00.000Z" },
      events: [{
        id: "event-1", runId: RUN.runId, projectId: PROJECT_ID, fileId: FILE_ID,
        kind: "drafts_staged", spanId: "span-1", summary: "Staged 3 drafts for review.",
        details: { staged: 3 }, createdAt: "2026-08-11T10:01:00.000Z",
      }],
      sceneBriefs: [{ id: "brief-1", l1Summary: "A teacher addresses a crowd.", ambiguityRegister: [] }],
      drafts: [{ id: "draft-1", cellId: "cell-1", status: "proposed", provenance: { runId: RUN.runId } }],
      truncated: true,
      truncatedCollections: { events: true, sceneBriefs: false, drafts: true },
    }))
    const activity = await fetchContextualRunActivity(PROJECT_ID, RUN.runId)
    expect(lastRequest().url).toContain(`/projects/proj%2F1/contextual/runs/${RUN.runId}/activity`)
    expect(activity.events[0]).toMatchObject({ kind: "drafts_staged", summary: "Staged 3 drafts for review.", details: { staged: 3 } })
    expect(activity.sceneBriefs[0]).toMatchObject({ id: "brief-1" })
    expect(activity.drafts[0]).toMatchObject({ cellId: "cell-1", status: "proposed" })
    expect(activity.truncatedCollections).toEqual({ events: true, sceneBriefs: false, drafts: true })
  })

  it("pages proposed draft evidence and preserves authoritative status counts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      run: {
        ...RUN,
        proposedDrafts: 700,
        callsSpent: 7,
        unitsSpent: 30,
        lastError: null,
        createdAt: "2026-08-11T10:00:00.000Z",
        updatedAt: "2026-08-11T10:02:00.000Z",
      },
      events: [],
      sceneBriefs: [],
      drafts: [{ id: "draft-older", cellId: "cell-older", status: "proposed" }],
      draftCounts: { proposed: 700, applied: 20, rejected: 3, superseded: 2 },
      draftNextCursor: { createdAt: "2026-08-11T09:00:00.000Z", draftId: "draft-older" },
      truncated: true,
      truncatedCollections: { events: false, sceneBriefs: false, drafts: true },
    }))

    const activity = await fetchContextualRunActivity(PROJECT_ID, RUN.runId, {
      draftStatus: "proposed",
      draftLimit: 100,
      draftCursor: { createdAt: "2026-08-11T09:30:00.000Z", draftId: "draft-newer" },
    })

    const url = new URL(lastRequest().url)
    expect(url.searchParams.get("draftStatus")).toBe("proposed")
    expect(url.searchParams.get("draftLimit")).toBe("100")
    expect(url.searchParams.get("draftBeforeCreatedAt")).toBe("2026-08-11T09:30:00.000Z")
    expect(url.searchParams.get("draftBeforeId")).toBe("draft-newer")
    expect(activity.draftCounts).toEqual({ proposed: 700, applied: 20, rejected: 3, superseded: 2 })
    expect(activity.draftNextCursor).toEqual({
      createdAt: "2026-08-11T09:00:00.000Z",
      draftId: "draft-older",
    })
  })

  it("sends guarded project-scoped controls and normalizes the returned run", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      run: {
        ...RUN,
        status: "paused",
        callsSpent: 8,
        unitsSpent: 31,
        lastError: null,
        createdAt: "2026-08-11T10:00:00.000Z",
        updatedAt: "2026-08-11T10:03:00.000Z",
      },
    }))
    const paused = await commandContextualRun(PROJECT_ID, RUN.runId, "pause")
    const request = lastRequest()
    expect(request.url).toContain(`/projects/proj%2F1/contextual/runs/${RUN.runId}/pause`)
    expect(request.init.method).toBe("POST")
    expect(paused).toMatchObject({ runId: RUN.runId, status: "paused", callsSpent: 8 })
  })
})

describe("installContextualTransport", () => {
  it("wires the real transport into the run-store so play POSTs /runs", async () => {
    installContextualTransport()
    fetchMock.mockResolvedValueOnce(jsonResponse({ runId: RUN.runId }))
    const ok = await startContextualRun(PROJECT_ID, FILE_ID)
    expect(ok).toBe(true)
    expect(lastRequest().url).toContain("/contextual/runs")
    expect(getContextualRunState().runId).toBe(RUN.runId)
    expect(getContextualRunState().status).toBe("running")
  })
})
