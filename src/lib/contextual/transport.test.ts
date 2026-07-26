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
  installContextualTransport,
  realContextualTransport,
  resetContextualTransportForTesting,
  sendContextualSteering,
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
  it("POSTs /runs/:id/steering with { text }", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ runId: RUN.runId }))
    await realContextualTransport.start(PROJECT_ID, FILE_ID)
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await sendContextualSteering(RUN.runId, "Prefer shorter sentences")
    const { url, init } = lastRequest()
    expect(url).toContain(`/runs/${RUN.runId}/steering`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({ text: "Prefer shorter sentences" })
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
