/**
 * changeset-api.test.ts — fetch-client contract tests for the staged-changeset
 * review flow (AQU-926). Verifies request shape (URL, method, headers, body),
 * the sync-token mint that fronts the sync-worker commit/discard calls, and
 * that non-OK responses surface the RIGHT typed error with the server's
 * curated message preserved verbatim.
 *
 * Fixtures mirror the real producers (AGENTS.md #12):
 * - approval GET / approve / reject: auth-worker/src/routes/
 *   changeset-approvals.ts — response literals at lines 270-281 (approval),
 *   361-365 (approve), 402 (reject); error envelope at errorJson(), digest
 *   mismatch details at lines 323-330.
 * - commit/discard: sync-worker/src/external/store.ts changesetToResponse
 *   (lines 98-116) with a ChangesetReceipt per
 *   sync-worker/src/external/types.ts (lines 113-121).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  approveChangeset,
  ChangesetApiError,
  commitChangeset,
  DigestMismatchError,
  discardChangeset,
  fetchChangesetApproval,
  rejectChangeset,
  type ChangesetApproval,
  type ChangesetStatus,
} from "./changeset-api"

const JWT = "session-jwt"
const PROJECT_ID = "proj-1"
const CHANGESET_ID = "cs-1"
const DIGEST = "sha256:0123456789abcdef0123456789abcdef"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Error envelope both workers share: `{ error: { code, message, details? } }`. */
function errorResponse(status: number, code: string, message: string, details?: unknown): Response {
  return jsonResponse({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, status)
}

/** Mirrors changeset-approvals.ts GET /:id/approval (lines 270-281). */
const APPROVAL: ChangesetApproval = {
  changesetId: CHANGESET_ID,
  projectId: PROJECT_ID,
  projectName: "Blackfoot",
  status: "staged",
  autonomyMode: "ask",
  summary: { translationsAdded: 2, warnings: [] },
  changes: {
    total: 2,
    truncated: false,
    items: [
      {
        fileId: "f1",
        fileName: "Genesis",
        cellId: "c1",
        canonicalRef: "GEN 1:1",
        source: "In the beginning",
        before: null,
        after: "Im Anfang",
      },
      {
        fileId: "f1",
        fileName: "Genesis",
        cellId: "c2",
        canonicalRef: "GEN 1:2",
        source: "And the earth",
        before: "alt",
        after: "Und die Erde",
      },
    ],
  },
  digest: DIGEST,
  createdAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-02T00:00:00.000Z",
}

/** Mirrors sync-worker store.ts changesetToResponse (lines 98-116). */
const COMMITTED: ChangesetStatus = {
  id: CHANGESET_ID,
  projectId: PROJECT_ID,
  createdByUserId: "42",
  credentialId: "session",
  autonomyMode: "ask",
  status: "committed",
  commands: [{ kind: "SetTranslation", fileId: "f1", cellId: "c1", value: "Im Anfang" }],
  preconditions: [],
  summary: { translationsAdded: 2, warnings: [] },
  digest: DIGEST,
  receipt: {
    eventIds: ["ev-1", "ev-2"],
    appliedCount: 2,
    staleCount: 0,
    warnings: [],
    committedAt: "2026-08-01T01:00:00.000Z",
  },
  confirmationId: "conf-1",
  createdAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-02T00:00:00.000Z",
  committedAt: "2026-08-01T01:00:00.000Z",
}

/** Sync-token mint response (auth-worker POST /api/v2/sync-token). */
const SYNC_TOKEN = {
  token: "sync-tok",
  expiresIn: 900,
  role: { level: 700, name: "OWNER", source: "creator" },
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchChangesetApproval", () => {
  it("GETs the approval with the session Bearer and returns the payload", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(APPROVAL))
    const result = await fetchChangesetApproval(JWT, CHANGESET_ID)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/api/v2/changesets/${CHANGESET_ID}/approval`)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${JWT}`)
    expect(result).toEqual(APPROVAL)
  })

  it("throws ChangesetApiError with the status on a 404", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404, "not_found", "changeset cs-1 not found"))
    const err = await fetchChangesetApproval(JWT, CHANGESET_ID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChangesetApiError)
    expect((err as ChangesetApiError).status).toBe(404)
    expect((err as ChangesetApiError).code).toBe("not_found")
    // Server message preserved verbatim — the cards render it inline.
    expect((err as ChangesetApiError).message).toBe("changeset cs-1 not found")
  })
})

describe("approveChangeset", () => {
  it("POSTs the digest and returns the one-time confirmation", async () => {
    // Mirrors changeset-approvals.ts lines 361-365.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        confirmationId: "conf-1",
        expiresAt: "2026-08-01T00:15:00.000Z",
        message: "Approved — the agent may now call commit/confirm_changeset.",
      }),
    )
    const result = await approveChangeset(JWT, CHANGESET_ID, DIGEST)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/api/v2/changesets/${CHANGESET_ID}/approve`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({ digest: DIGEST })
    expect(result.confirmationId).toBe("conf-1")
  })

  it("throws DigestMismatchError for the 409 digest_mismatch detail", async () => {
    // Mirrors changeset-approvals.ts lines 323-330.
    fetchMock.mockResolvedValueOnce(
      errorResponse(
        409,
        "validation_failed",
        "digest mismatch — the plan you're approving doesn't match the staged changeset",
        { code: "digest_mismatch" },
      ),
    )
    const err = await approveChangeset(JWT, CHANGESET_ID, "stale-digest").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DigestMismatchError)
    expect((err as DigestMismatchError).status).toBe(409)
  })

  it("throws a plain ChangesetApiError for an expired changeset", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(409, "validation_failed", "changeset has expired"))
    const err = await approveChangeset(JWT, CHANGESET_ID, DIGEST).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChangesetApiError)
    expect(err).not.toBeInstanceOf(DigestMismatchError)
    expect((err as ChangesetApiError).message).toBe("changeset has expired")
  })
})

describe("rejectChangeset", () => {
  it("POSTs without a body and returns the discarded status", async () => {
    // Mirrors changeset-approvals.ts line 402.
    fetchMock.mockResolvedValueOnce(jsonResponse({ changesetId: CHANGESET_ID, status: "discarded" }))
    const result = await rejectChangeset(JWT, CHANGESET_ID)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/api/v2/changesets/${CHANGESET_ID}/reject`)
    expect(init.method).toBe("POST")
    expect(init.body).toBeUndefined()
    expect(result.status).toBe("discarded")
  })
})

describe("commitChangeset", () => {
  it("mints a __project__-scoped sync token, then POSTs commit with it", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SYNC_TOKEN))
      .mockResolvedValueOnce(jsonResponse(COMMITTED))

    const result = await commitChangeset(JWT, PROJECT_ID, CHANGESET_ID)

    const [mintUrl, mintInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(mintUrl).toContain("/api/v2/sync-token")
    expect(JSON.parse(String(mintInit.body))).toEqual({
      projectId: PROJECT_ID,
      fileId: "__project__",
    })

    const [commitUrl, commitInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(commitUrl).toContain(`/api/v1/changesets/${PROJECT_ID}/${CHANGESET_ID}/commit`)
    expect(commitInit.method).toBe("POST")
    expect((commitInit.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SYNC_TOKEN.token}`,
    )

    expect(result.status).toBe("committed")
    expect(result.receipt?.appliedCount).toBe(2)
  })

  it("unwraps a { changeset } envelope, matching the external route shape", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SYNC_TOKEN))
      .mockResolvedValueOnce(jsonResponse({ changeset: COMMITTED }))
    const result = await commitChangeset(JWT, PROJECT_ID, CHANGESET_ID)
    expect(result.id).toBe(CHANGESET_ID)
    expect(result.receipt?.eventIds).toEqual(["ev-1", "ev-2"])
  })

  it("surfaces the sync-worker error contract (plan_stale) with code and message", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SYNC_TOKEN))
      .mockResolvedValueOnce(errorResponse(409, "plan_stale", "cells changed since staging"))
    const err = await commitChangeset(JWT, PROJECT_ID, CHANGESET_ID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChangesetApiError)
    expect((err as ChangesetApiError).code).toBe("plan_stale")
    expect((err as ChangesetApiError).status).toBe(409)
  })

  it("folds a sync-token mint failure into ChangesetApiError with its status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }))
    const err = await commitChangeset(JWT, PROJECT_ID, CHANGESET_ID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChangesetApiError)
    expect((err as ChangesetApiError).status).toBe(403)
    // The commit endpoint was never reached.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("discardChangeset", () => {
  it("POSTs discard with the sync token and returns the status payload", async () => {
    const discarded: ChangesetStatus = { ...COMMITTED, status: "discarded", receipt: null, committedAt: null }
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SYNC_TOKEN))
      .mockResolvedValueOnce(jsonResponse({ changeset: discarded }))
    const result = await discardChangeset(JWT, PROJECT_ID, CHANGESET_ID)
    const [discardUrl] = fetchMock.mock.calls[1] as [string]
    expect(discardUrl).toContain(`/api/v1/changesets/${PROJECT_ID}/${CHANGESET_ID}/discard`)
    expect(result.status).toBe("discarded")
  })
})
