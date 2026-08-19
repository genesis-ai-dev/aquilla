/**
 * changeset-api.test.ts — fetch-client contract tests for the staged-changeset
 * review flow (AQU-926). Verifies request shape (URL, method, headers, body),
 * the sync-token mint that fronts the sync-worker commit/discard calls, and
 * that non-OK responses surface the RIGHT typed error with the server's
 * curated message preserved verbatim.
 *
 * Fixtures mirror the real producers (AGENTS.md #12):
 * - approval GET / approve / reject: auth-worker/src/routes/
 *   changeset-approvals.ts — response literals at lines 143-156 (approval),
 *   234-238 (approve), 273 (reject); error envelope at errorJson() (line 46),
 *   digest mismatch details at lines 196-201.
 * - commit/discard: sync-worker/src/external/store.ts changesetToResponse
 *   (lines 166-184) with a ChangesetReceipt per
 *   sync-worker/src/external/types.ts (lines 140-148).
 *
 * AQU-CMDREG-P1 additions (docs/COMMAND-REGISTRY-P1.md):
 * - `assignedToUserId` on the approval payload: changeset-approvals.ts
 *   response literal line 152 (`assignedToUserId: cs.assigned_to_user_id`),
 *   row column at line 64 — always present, `null` when unassigned.
 * - list + `heldCount`/`surfacedCap`: sync-worker/src/external/session-routes.ts
 *   handleList lines 142-151, rows from the same changesetToResponse plus the
 *   route's `approvalUrl`.
 * - `superseded` status: sync-worker/src/external/store.ts CHANGESET_STATUSES
 *   (lines 99-101).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  approveChangeset,
  CHANGESET_STATUSES,
  ChangesetApiError,
  commitChangeset,
  DigestMismatchError,
  discardChangeset,
  fetchChangesetApproval,
  isChangesetStatusName,
  listProjectChangesets,
  rejectChangeset,
  SURFACED_CAP,
  type ChangesetApproval,
  type ChangesetListItem,
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
  assignedToUserId: null,
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

// ───────────────────────────────────────────────────────────────────────────
// AQU-CMDREG-P1 — supersession, routing, and the capped pending inbox.
// ───────────────────────────────────────────────────────────────────────────

describe("changeset status vocabulary (P1 §1)", () => {
  it("admits superseded alongside the shipped statuses", () => {
    // Mirrors sync-worker/src/external/store.ts CHANGESET_STATUSES (99-101) —
    // the list every status filter validates against.
    expect([...CHANGESET_STATUSES]).toEqual([
      "staged",
      "committing",
      "committed",
      "discarded",
      "stale",
      "superseded",
      "expired",
    ])
    expect(isChangesetStatusName("superseded")).toBe(true)
    expect(isChangesetStatusName("supercede")).toBe(false)
  })

  it("carries a superseded approval through without collapsing it into stale", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...APPROVAL, status: "superseded" }))
    const result = await fetchChangesetApproval(JWT, CHANGESET_ID)
    expect(result.status).toBe("superseded")
  })
})

describe("fetchChangesetApproval — assignment (P1 §2.2)", () => {
  it("returns the assignee when the changeset is routed, still staged", async () => {
    // Assignment never changes status: changeset-approvals.ts line 151-152.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...APPROVAL, assignedToUserId: "77", status: "staged" }),
    )
    const result = await fetchChangesetApproval(JWT, CHANGESET_ID)
    expect(result.assignedToUserId).toBe("77")
    expect(result.status).toBe("staged")
  })

  it("returns null for an unassigned changeset", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(APPROVAL))
    const result = await fetchChangesetApproval(JWT, CHANGESET_ID)
    expect(result.assignedToUserId).toBeNull()
  })
})

describe("listProjectChangesets (P1 §3.3)", () => {
  /** One list row: changesetToResponse (store.ts 166-184) plus the
   *  approvalUrl handleList appends (session-routes.ts 143-146). */
  function listRow(id: string, status: ChangesetStatus["status"] = "staged"): ChangesetListItem {
    return {
      ...COMMITTED,
      id,
      status,
      receipt: status === "committed" ? COMMITTED.receipt : null,
      committedAt: status === "committed" ? COMMITTED.committedAt : null,
      approvalUrl: `https://app.example/approve/${id}`,
    }
  }

  /** Mirrors handleList's response literal (session-routes.ts 142-151). */
  const PAGE = {
    changesets: [listRow("cs-a"), listRow("cs-b"), listRow("cs-c")],
    heldCount: 2,
    surfacedCap: 3,
  }

  it("mints a __project__ sync token, then GETs the list with it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SYNC_TOKEN)).mockResolvedValueOnce(jsonResponse(PAGE))

    const page = await listProjectChangesets(JWT, PROJECT_ID)

    const [mintUrl, mintInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(mintUrl).toContain("/api/v2/sync-token")
    expect(JSON.parse(String(mintInit.body))).toEqual({ projectId: PROJECT_ID, fileId: "__project__" })

    const [listUrl, listInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(listUrl).toContain(`/api/v1/changesets/${PROJECT_ID}`)
    expect((listInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${SYNC_TOKEN.token}`)

    // The held remainder arrives as a COUNT, never as extra rows.
    expect(page.changesets).toHaveLength(3)
    expect(page.changesets.length).toBeLessThanOrEqual(page.surfacedCap)
    expect(page.heldCount).toBe(2)
  })

  it("passes status and limit through as query params", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SYNC_TOKEN))
      .mockResolvedValueOnce(jsonResponse({ ...PAGE, heldCount: 0 }))
    await listProjectChangesets(JWT, PROJECT_ID, { status: "superseded", limit: 25 })
    const [listUrl] = fetchMock.mock.calls[1] as [string]
    expect(listUrl).toContain("status=superseded")
    expect(listUrl).toContain("limit=25")
  })

  it("reads a pre-P1 worker (no heldCount/surfacedCap) as nothing held", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SYNC_TOKEN))
      .mockResolvedValueOnce(jsonResponse({ changesets: [listRow("cs-a")] }))
    const page = await listProjectChangesets(JWT, PROJECT_ID)
    expect(page.heldCount).toBe(0)
    expect(page.surfacedCap).toBe(SURFACED_CAP)
  })

  it("surfaces the shared error envelope on a rejected status filter", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SYNC_TOKEN))
      .mockResolvedValueOnce(
        errorResponse(409, "validation_failed", 'unknown status filter "nope"', {
          statuses: CHANGESET_STATUSES,
        }),
      )
    const err = await listProjectChangesets(JWT, PROJECT_ID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChangesetApiError)
    expect((err as ChangesetApiError).code).toBe("validation_failed")
  })
})
