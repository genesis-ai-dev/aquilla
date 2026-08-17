/**
 * ChangesetCard tests.
 *
 * Legacy frames (no `digest` on the frame — AQU-926 feature detection): the
 * summary/cell-count facts render, sample per-cell changes from
 * GET /api/v2/changesets/:id/approval render inline, Approve/Reject act
 * in-conversation (approve POSTs the GET's digest — never one the frame
 * carried), the "View full details" link still points at approvalUrl in a new
 * tab, and (mem-M5) polling stops once the status turns terminal. These are
 * the REGRESSION suite for "frames without the new fields render as before".
 *
 * Fresh frames (digest/tier/kinds present) render the live review card:
 * load → diffs, Approve & apply (approve then sync-worker commit, in order),
 * execution receipt + onApplied revalidation seam, per-item testimony gating,
 * reject, and the stale/expired drift surface with Refresh. Fixtures mirror
 * auth-worker/src/routes/changeset-approvals.ts (approval lines 270-281,
 * approve 361-365, reject 402) and sync-worker/src/external/store.ts
 * changesetToResponse (98-116) + types.ts ChangesetReceipt (113-121).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChangesetItem } from "@/lib/agent/run-state"
import { ChangesetCard } from "./ChangesetCard"
import { testimonyEntriesFor } from "@/lib/agent/changeset-review"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: vi.fn(() => ({ session: { jwt: "test-jwt", username: "alice" }, loading: false })),
}))

function item(overrides: Partial<ChangesetItem> = {}): ChangesetItem {
  return {
    id: "i0",
    kind: "changeset",
    changesetId: "cs-1",
    approvalUrl: "https://app.example/approve/cs-1",
    summary: "Import glossary.csv",
    cellCount: 40,
    ...overrides,
  }
}

const DIGEST = "sha256:0123456789abcdef"

function approvalPayload(status: string, extra: Record<string, unknown> = {}) {
  return {
    status,
    digest: DIGEST,
    changes: {
      total: 5,
      truncated: false,
      items: [
        { fileId: "f1", fileName: "Genesis", cellId: "c1", canonicalRef: "GEN 1:1", source: "src 1", before: "old 1", after: "new 1" },
        { fileId: "f1", fileName: "Genesis", cellId: "c2", canonicalRef: "GEN 1:2", source: "src 2", before: null, after: "new 2" },
        { fileId: "f1", fileName: "Genesis", cellId: "c3", canonicalRef: "GEN 1:3", source: "src 3", before: "old 3", after: "new 3" },
        { fileId: "f1", fileName: "Genesis", cellId: "c4", canonicalRef: "GEN 1:4", source: "src 4", before: "old 4", after: "new 4" },
        { fileId: "f1", fileName: "Genesis", cellId: "c5", canonicalRef: "GEN 1:5", source: "src 5", before: "old 5", after: "new 5" },
      ],
    },
    ...extra,
  }
}

function mockApproval(status: string, extra: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => approvalPayload(status, extra),
  } as Response)
}

describe("ChangesetCard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockApproval("staged"))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("shows the summary and cell count", () => {
    render(<ChangesetCard item={item()} />)
    expect(screen.getByText("Import glossary.csv")).toBeInTheDocument()
    expect(screen.getByText("40 cells")).toBeInTheDocument()
  })

  it("singularizes the cell count for a single cell", () => {
    render(<ChangesetCard item={item({ cellCount: 1 })} />)
    expect(screen.getByText("1 cell")).toBeInTheDocument()
  })

  it('tags the card with data-frame-type="changeset.staged" for e2e selectors', () => {
    const { container } = render(<ChangesetCard item={item()} />)
    expect(container.querySelector('[data-frame-type="changeset.staged"]')).not.toBeNull()
  })

  it("links View full details to approvalUrl, opened in a new tab", () => {
    render(<ChangesetCard item={item()} />)
    const link = screen.getByRole("link", { name: /View full details/ })
    expect(link).toHaveAttribute("href", "https://app.example/approve/cs-1")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"))
  })

  it("renders a capped sample of the per-cell changes from the approval payload", async () => {
    render(<ChangesetCard item={item()} />)

    // First three of five changes render; the rest are counted, not shown.
    expect(await screen.findByText("new 1")).toBeInTheDocument()
    expect(screen.getByText("old 1")).toBeInTheDocument()
    expect(screen.getByText("new 3")).toBeInTheDocument()
    expect(screen.queryByText("new 4")).not.toBeInTheDocument()
    expect(screen.getByText(/and 2 more changes/i)).toBeInTheDocument()
  })

  it("approves in place: POSTs the fetched digest and shows the approved state", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/approval")) {
        return { ok: true, json: async () => approvalPayload("staged") } as Response
      }
      if (String(url).endsWith("/approve")) {
        const body = JSON.parse(String(init?.body)) as { digest: string }
        expect(body.digest).toBe(DIGEST)
        return { ok: true, json: async () => ({ confirmationId: "conf-1" }) } as Response
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const { container } = render(<ChangesetCard item={item()} />)
    const approveBtn = await screen.findByRole("button", { name: /Approve/ })
    approveBtn.click()

    await waitFor(() =>
      expect(screen.getByText(/the agent can now commit/i)).toBeInTheDocument(),
    )
    expect(container.querySelector('[data-changeset-status="approved"]')).not.toBeNull()
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument()
  })

  it("rejects in place and flips to Discarded", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/approval")) {
        return { ok: true, json: async () => approvalPayload("staged") } as Response
      }
      if (String(url).endsWith("/reject")) {
        return { ok: true, json: async () => ({ changesetId: "cs-1", status: "discarded" }) } as Response
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<ChangesetCard item={item()} />)
    const rejectBtn = await screen.findByRole("button", { name: /Reject/ })
    rejectBtn.click()

    await waitFor(() => expect(screen.getByText("Discarded")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument()
  })

  it("surfaces an action error without losing the card", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/approval")) {
        return { ok: true, json: async () => approvalPayload("staged") } as Response
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: { code: "validation_failed", message: "changeset has expired" } }),
      } as Response
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<ChangesetCard item={item()} />)
    const approveBtn = await screen.findByRole("button", { name: /Approve/ })
    approveBtn.click()

    await waitFor(() => expect(screen.getByText("changeset has expired")).toBeInTheDocument())
    // Still actionable after a failed attempt.
    expect(screen.getByRole("button", { name: /Approve/ })).toBeInTheDocument()
  })

  it("shows Committed and no action buttons for a committed changeset", async () => {
    vi.stubGlobal("fetch", mockApproval("committed"))
    render(<ChangesetCard item={item()} />)

    await waitFor(() => expect(screen.getByText("Committed")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Reject/ })).not.toBeInTheDocument()
  })

  it("stops polling once a terminal status is reached", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const fetchMock = mockApproval("discarded")
      vi.stubGlobal("fetch", fetchMock)
      render(<ChangesetCard item={item()} />)

      await waitFor(() => expect(screen.getByText("Discarded")).toBeInTheDocument())
      const callsAtTerminal = fetchMock.mock.calls.length

      // Two more poll intervals would fire if polling hadn't stopped.
      await vi.advanceTimersByTimeAsync(15000)
      expect(fetchMock.mock.calls.length).toBe(callsAtTerminal)
    } finally {
      vi.useRealTimers()
    }
  })

  it("never shows the live-flow Approve & apply for a legacy frame (regression)", async () => {
    render(<ChangesetCard item={item()} />)
    await screen.findByRole("button", { name: /^Approve$/ })
    expect(screen.queryByRole("button", { name: /Approve & apply/ })).not.toBeInTheDocument()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Live review card — frames carrying the AQU-926 digest/tier/kinds fields.
// ───────────────────────────────────────────────────────────────────────────

const LIVE_DIGEST = "sha256:feedfacefeedface0123456789abcdef"

function liveItem(overrides: Partial<ChangesetItem> = {}): ChangesetItem {
  return {
    id: "i0",
    kind: "changeset",
    changesetId: "cs-9",
    approvalUrl: "https://app.example/approve/cs-9",
    summary: "Set 2 translations in Genesis",
    cellCount: 2,
    digest: LIVE_DIGEST,
    tier: "prepared",
    kinds: ["SetTranslation"],
    ...overrides,
  }
}

/** Mirrors auth-worker changeset-approvals.ts GET response (lines 270-281),
 *  with per-cell rows shaped by buildChangeDetails (lines 195-213). */
function liveApproval(overrides: Record<string, unknown> = {}) {
  return {
    changesetId: "cs-9",
    projectId: "proj-1",
    projectName: "Blackfoot",
    status: "staged",
    autonomyMode: "ask",
    summary: { translationsAdded: 1, translationsModified: 1, warnings: [] },
    changes: {
      total: 2,
      truncated: false,
      items: [
        { fileId: "f1", fileName: "Genesis", cellId: "c1", canonicalRef: "GEN 1:1", source: "In the beginning", before: null, after: "Im Anfang" },
        { fileId: "f1", fileName: "Genesis", cellId: "c2", canonicalRef: "GEN 1:2", source: "And the earth", before: "alt", after: "Und die Erde" },
      ],
    },
    digest: LIVE_DIGEST,
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  }
}

/** Mirrors sync-worker store.ts changesetToResponse (lines 98-116); receipt
 *  per types.ts ChangesetReceipt (lines 113-121). */
const COMMITTED_RESPONSE = {
  id: "cs-9",
  projectId: "proj-1",
  createdByUserId: "42",
  credentialId: "session",
  autonomyMode: "ask",
  status: "committed",
  commands: [{ kind: "SetTranslation", fileId: "f1", cellId: "c1", value: "Im Anfang" }],
  preconditions: [],
  summary: { translationsAdded: 1, translationsModified: 1, warnings: [] },
  digest: LIVE_DIGEST,
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

const SYNC_TOKEN_RESPONSE = {
  token: "sync-tok",
  expiresIn: 900,
  role: { level: 700, name: "OWNER", source: "creator" },
}

type RouteMap = Partial<Record<"approval" | "approve" | "syncToken" | "commit" | "reject", () => Response>>

/** URL-dispatching fetch stub covering the full approve→mint→commit chain. */
function routedFetch(routes: RouteMap) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const u = String(url)
    if (u.includes("/approval")) return (routes.approval ?? (() => json(liveApproval())))()
    if (u.includes("/approve")) {
      return (routes.approve ?? (() => json({ confirmationId: "conf-1", expiresAt: "2026-08-01T00:15:00.000Z" })))()
    }
    if (u.includes("/sync-token")) return (routes.syncToken ?? (() => json(SYNC_TOKEN_RESPONSE)))()
    if (u.includes("/commit")) return (routes.commit ?? (() => json(COMMITTED_RESPONSE)))()
    if (u.includes("/reject")) return (routes.reject ?? (() => json({ changesetId: "cs-9", status: "discarded" })))()
    throw new Error(`unexpected fetch: ${u}`)
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function errorJson(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status)
}

describe("ChangesetCard — live review (AQU-926 frames)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("loads the approval and renders diffs, kinds, and Approve & apply", async () => {
    vi.stubGlobal("fetch", routedFetch({}))
    render(<ChangesetCard item={liveItem()} />)

    expect(await screen.findByText("Im Anfang")).toBeInTheDocument()
    expect(screen.getByText("Und die Erde")).toBeInTheDocument()
    // Replaced text renders struck through as the before value.
    expect(screen.getByText("alt")).toBeInTheDocument()
    expect(screen.getByText("SetTranslation")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Approve & apply/ })).toBeEnabled()
    expect(screen.getByRole("button", { name: /Reject/ })).toBeEnabled()
    // The frame's summary line still heads the card.
    expect(screen.getByText("Set 2 translations in Genesis")).toBeInTheDocument()
  })

  it("caps the diff list at 20 rows and counts the remainder", async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      fileId: "f1",
      fileName: "Genesis",
      cellId: `c${i}`,
      canonicalRef: `GEN 1:${i + 1}`,
      source: `src ${i}`,
      before: null,
      after: `after ${i}`,
    }))
    vi.stubGlobal(
      "fetch",
      routedFetch({ approval: () => json(liveApproval({ changes: { total: 25, truncated: false, items } })) }),
    )
    render(<ChangesetCard item={liveItem()} />)

    expect(await screen.findByText("after 0")).toBeInTheDocument()
    expect(screen.getByText("after 19")).toBeInTheDocument()
    expect(screen.queryByText("after 20")).not.toBeInTheDocument()
    expect(screen.getByText(/and 5 more changes/i)).toBeInTheDocument()
  })

  it("Approve & apply: approves with the GET digest, then commits, then reports the receipt", async () => {
    const fetchMock = routedFetch({})
    vi.stubGlobal("fetch", fetchMock)
    const onApplied = vi.fn()
    const { container } = render(<ChangesetCard item={liveItem()} onApplied={onApplied} />)

    fireEvent.click(await screen.findByRole("button", { name: /Approve & apply/ }))

    await waitFor(() => expect(screen.getByText(/Applied 2 changes\./)).toBeInTheDocument())
    expect(container.querySelector('[data-changeset-status="committed"]')).not.toBeNull()
    expect(screen.getByText("Committed")).toBeInTheDocument()

    // Call order: approval GET, approve POST (with the GET's digest), sync-token
    // mint, sync-worker commit.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls[0]).toContain("/api/v2/changesets/cs-9/approval")
    expect(urls[1]).toContain("/api/v2/changesets/cs-9/approve")
    expect(urls[2]).toContain("/api/v2/sync-token")
    expect(urls[3]).toContain("/api/v1/changesets/proj-1/cs-9/commit")
    const approveInit = fetchMock.mock.calls[1][1]
    expect(JSON.parse(String(approveInit?.body))).toEqual({ digest: LIVE_DIGEST })

    // Revalidation seam: receipt event ids + the diffed cell ids.
    expect(onApplied).toHaveBeenCalledWith(["ev-1", "ev-2"], ["c1", "c2"])
    // Buttons are gone once committed.
    expect(screen.queryByRole("button", { name: /Approve & apply/ })).not.toBeInTheDocument()
  })

  it("gates Approve & apply behind per-item testimony confirmation", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        approval: () =>
          json(
            liveApproval({
              summary: {
                warnings: [],
                events: [
                  { kind: "cell.validate", count: 2, testimony: true },
                  { kind: "comment.create", count: 1, testimony: false },
                ],
              },
            }),
          ),
      }),
    )
    render(<ChangesetCard item={liveItem({ tier: "structural", kinds: ["EmitEvents"] })} />)

    // Only the testimony-marked entry needs confirmation.
    const label = await screen.findByText("cell.validate × 2")
    expect(screen.queryByText(/comment\.create/)).not.toBeInTheDocument()
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
    const applyButton = screen.getByRole("button", { name: /Approve & apply/ })
    expect(applyButton).toBeDisabled()

    // Clicking the label toggles the Base UI checkbox through its hidden
    // labelable input (same idiom as AssignModal tests).
    fireEvent.click(label)
    await waitFor(() => expect(screen.getByRole("button", { name: /Approve & apply/ })).toBeEnabled())
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true")
  })

  it("requires EVERY testimony item before enabling (two entries)", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        approval: () =>
          json(
            liveApproval({
              summary: {
                warnings: [],
                events: [
                  { kind: "cell.validate", count: 2, testimony: true },
                  { kind: "cell.unvalidate", count: 1, testimony: true },
                ],
              },
            }),
          ),
      }),
    )
    render(<ChangesetCard item={liveItem({ tier: "structural", kinds: ["EmitEvents"] })} />)

    fireEvent.click(await screen.findByText("cell.validate × 2"))
    // One of two confirmed — still gated.
    await waitFor(() =>
      expect(screen.getAllByRole("checkbox")[0].getAttribute("aria-checked")).toBe("true"),
    )
    expect(screen.getByRole("button", { name: /Approve & apply/ })).toBeDisabled()

    fireEvent.click(screen.getByText("cell.unvalidate × 1"))
    await waitFor(() => expect(screen.getByRole("button", { name: /Approve & apply/ })).toBeEnabled())
  })

  it("rejects in place and flips to Discarded", async () => {
    const fetchMock = routedFetch({})
    vi.stubGlobal("fetch", fetchMock)
    render(<ChangesetCard item={liveItem()} />)

    fireEvent.click(await screen.findByRole("button", { name: /Reject/ }))

    await waitFor(() => expect(screen.getByText("Discarded")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /Approve & apply/ })).not.toBeInTheDocument()
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes("/api/v2/changesets/cs-9/reject"))).toBe(true)
  })

  it("surfaces a stale commit (plan_stale) with the message, Stale chip, and a working Refresh", async () => {
    const fetchMock = routedFetch({
      commit: () => errorJson(409, "plan_stale", "cells changed since staging"),
    })
    vi.stubGlobal("fetch", fetchMock)
    render(<ChangesetCard item={liveItem()} />)

    fireEvent.click(await screen.findByRole("button", { name: /Approve & apply/ }))

    await waitFor(() => expect(screen.getByText("cells changed since staging")).toBeInTheDocument())
    expect(screen.getByText("Stale")).toBeInTheDocument()

    const approvalCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/approval")).length
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }))
    await waitFor(() => {
      const approvalCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/approval")).length
      expect(approvalCalls).toBe(approvalCallsBefore + 1)
    })
  })

  it("surfaces an expired approve with the server message and a Refresh", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({ approve: () => errorJson(409, "validation_failed", "changeset has expired") }),
    )
    render(<ChangesetCard item={liveItem()} />)

    fireEvent.click(await screen.findByRole("button", { name: /Approve & apply/ }))

    await waitFor(() => expect(screen.getByText("changeset has expired")).toBeInTheDocument())
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeInTheDocument()
    // Still reviewable after the failure — the card is not lost.
    expect(screen.getByRole("button", { name: /Approve & apply/ })).toBeInTheDocument()
  })

  it("surfaces a digest mismatch as a refreshable drift error", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        approve: () =>
          json(
            {
              error: {
                code: "validation_failed",
                message: "digest mismatch — the plan you're approving doesn't match the staged changeset",
                details: { code: "digest_mismatch" },
              },
            },
            409,
          ),
      }),
    )
    render(<ChangesetCard item={liveItem()} />)

    fireEvent.click(await screen.findByRole("button", { name: /Approve & apply/ }))

    await waitFor(() => expect(screen.getByText(/digest mismatch/)).toBeInTheDocument())
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeInTheDocument()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// testimonyEntriesFor — the fallback ladder when the summary doesn't itemize.
// ───────────────────────────────────────────────────────────────────────────

describe("testimonyEntriesFor", () => {
  const base = { summary: "Validate MRK 4", tier: undefined, kinds: undefined } as const

  function approvalWith(events?: { kind: string; count: number; testimony?: boolean }[]) {
    return liveApproval(
      events ? { summary: { warnings: [], events } } : { summary: { warnings: [] } },
    ) as unknown as import("@/lib/agent/changeset-api").ChangesetApproval
  }

  it("prefers summary-marked testimony events, ignoring prepared ones", () => {
    const entries = testimonyEntriesFor(
      { ...base, tier: "structural", kinds: ["EmitEvents"] },
      approvalWith([
        { kind: "cell.validate", count: 2, testimony: true },
        { kind: "comment.create", count: 5 },
      ]),
    )
    expect(entries).toEqual([{ key: "event:cell.validate", label: "cell.validate × 2" }])
  })

  it("treats registry testimony kinds as testimony even without the summary mark", () => {
    const entries = testimonyEntriesFor(
      { ...base },
      approvalWith([{ kind: "cell.unvalidate", count: 1 }]),
    )
    expect(entries).toEqual([{ key: "event:cell.unvalidate", label: "cell.unvalidate × 1" }])
  })

  it("tier=testimony with no itemized events falls back to the frame kinds", () => {
    const entries = testimonyEntriesFor(
      { ...base, tier: "testimony", kinds: ["EmitEvents"] },
      approvalWith(),
    )
    expect(entries).toEqual([{ key: "kind:EmitEvents", label: "EmitEvents" }])
  })

  it("tier=testimony with nothing itemizable gates on a single changeset-wide entry", () => {
    const entries = testimonyEntriesFor({ ...base, tier: "testimony" }, approvalWith())
    expect(entries).toEqual([{ key: "changeset", label: "Validate MRK 4" }])
  })

  it("prepared changesets with no testimony marks need no confirmations", () => {
    const entries = testimonyEntriesFor(
      { ...base, tier: "prepared", kinds: ["SetTranslation"] },
      approvalWith([{ kind: "target.cell.commit", count: 4 }]),
    )
    expect(entries).toEqual([])
  })
})
