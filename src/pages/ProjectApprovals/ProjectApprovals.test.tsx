/**
 * ProjectApprovals.test.tsx — AQU-841.
 *
 * Producer→consumer contract (AGENTS.md #12): the fixtures below are the
 * sync-worker list route's real envelope (`changesetToResponse` + `approvalUrl`
 * + `heldCount`/`surfacedCap`, session-routes.ts handleList) and the
 * auth-worker approval GET's real payload, passed through the page's own
 * client (`listProjectChangesets` / `fetchChangesetApproval`) rather than a
 * hand-built shape.
 *
 * The two invariants the queue must not relax get a test each: the digest is
 * always the one the approval GET returned, and testimony is never swept up by
 * the bulk action.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { ProjectApprovals } from "./ProjectApprovals"

let sessionValue: { session: { jwt: string } | null; loading: boolean } = {
  session: { jwt: "test-jwt" },
  loading: false,
}
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => sessionValue,
}))

const PROJECT_ID = "proj-1"

/** One row of the list route: `changesetToResponse` plus `approvalUrl`. */
function listRow(
  id: string,
  summary: Record<string, unknown>,
  digest = `sha256:${id}-list-digest`,
) {
  return {
    id,
    projectId: PROJECT_ID,
    createdByUserId: "user-1",
    credentialId: "cred-1",
    autonomyMode: "ask",
    status: "staged",
    commands: [],
    preconditions: [],
    summary,
    digest,
    receipt: null,
    confirmationId: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    expiresAt: "2026-08-11T00:00:00.000Z",
    committedAt: null,
    approvalUrl: `https://aquilla.app/approve/${id}`,
  }
}

/** The auth-worker approval GET payload for a row. Its digest deliberately
 *  differs from the list row's, so a test can prove which one is approved. */
function approvalFor(id: string) {
  return {
    changesetId: id,
    projectId: PROJECT_ID,
    projectName: "Blackfoot",
    status: "staged",
    autonomyMode: "ask",
    summary: { translationsAdded: 2 },
    digest: `sha256:${id}-approval-digest`,
    createdAt: "2026-08-10T00:00:00.000Z",
    expiresAt: "2026-08-11T00:00:00.000Z",
  }
}

const SYNC_TOKEN_BODY = { token: "sync-token", expiresAt: "2026-08-11T00:00:00.000Z" }

/**
 * Route the page's real network calls. `list` is the list-route body; the
 * sync-token mint, per-changeset approval GET, approve and reject POSTs are
 * served from the same handler so the assertions can read the true call order.
 */
function stubFetch(options: {
  list: { changesets: unknown[]; heldCount: number; surfacedCap: number }
  onApprove?: (id: string, digest: string) => Response
  onReject?: (id: string) => Response
}) {
  const calls: { url: string; method: string; body?: string }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined })

    if (url.includes("/sync-token")) {
      return new Response(JSON.stringify(SYNC_TOKEN_BODY), { status: 200 })
    }
    if (url.includes("/api/v1/changesets/")) {
      return new Response(JSON.stringify(options.list), { status: 200 })
    }
    if (url.endsWith("/approval")) {
      const id = url.split("/api/v2/changesets/")[1].split("/")[0]
      return new Response(JSON.stringify(approvalFor(id)), { status: 200 })
    }
    if (url.endsWith("/approve")) {
      const id = url.split("/api/v2/changesets/")[1].split("/")[0]
      const digest = (JSON.parse(String(init?.body)) as { digest: string }).digest
      return (
        options.onApprove?.(id, digest) ??
        new Response(
          JSON.stringify({ confirmationId: `conf-${id}`, expiresAt: "2026-08-11T00:00:00.000Z" }),
          { status: 200 },
        )
      )
    }
    if (url.endsWith("/reject")) {
      const id = url.split("/api/v2/changesets/")[1].split("/")[0]
      return (
        options.onReject?.(id) ??
        new Response(JSON.stringify({ changesetId: id, status: "discarded" }), { status: 200 })
      )
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return calls
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/project/${PROJECT_ID}/approvals`]}>
      <Routes>
        <Route path="/project/:id/approvals" element={<ProjectApprovals />} />
      </Routes>
    </MemoryRouter>,
  )
}

function rowFor(changesetId: string): HTMLElement {
  const el = document.querySelector(`[data-changeset-id="${changesetId}"]`)
  if (!el) throw new Error(`no row rendered for ${changesetId}`)
  return el as HTMLElement
}

beforeEach(() => {
  sessionValue = { session: { jwt: "test-jwt" }, loading: false }
  vi.restoreAllMocks()
})

describe("ProjectApprovals (AQU-841)", () => {
  it("lists every staged plan the project has, not the default 3-row view", async () => {
    const calls = stubFetch({
      list: {
        changesets: [
          listRow("cs-1", { translationsAdded: 4 }),
          listRow("cs-2", { translationsModified: 1 }),
        ],
        heldCount: 0,
        surfacedCap: 3,
      },
    })

    renderPage()

    await waitFor(() => expect(screen.getByTestId("approvals-queue")).toBeInTheDocument())
    // Count the plan rows themselves — each row nests its own <li> facts list.
    expect(document.querySelectorAll("[data-changeset-id]")).toHaveLength(2)
    expect(screen.getByText(/translations added/i)).toBeInTheDocument()

    // An explicit limit is what makes this a queue rather than a sample: without
    // it the server applies SURFACED_CAP and holds the rest back as a count.
    const listCall = calls.find((c) => c.url.includes("/api/v1/changesets/"))
    expect(listCall?.url).toContain("status=staged")
    expect(listCall?.url).toContain("limit=50")
  })

  it("approves with the digest from the approval GET, never the list row's", async () => {
    const approved: { id: string; digest: string }[] = []
    stubFetch({
      list: { changesets: [listRow("cs-1", { translationsAdded: 4 })], heldCount: 0, surfacedCap: 3 },
      onApprove: (id, digest) => {
        approved.push({ id, digest })
        return new Response(
          JSON.stringify({ confirmationId: "conf-1", expiresAt: "2026-08-11T00:00:00.000Z" }),
          { status: 200 },
        )
      },
    })

    renderPage()
    await waitFor(() => expect(screen.getByTestId("approvals-queue")).toBeInTheDocument())
    await userEvent.click(within(rowFor("cs-1")).getByRole("button", { name: /approve/i }))

    await waitFor(() => expect(approved).toHaveLength(1))
    expect(approved[0].digest).toBe("sha256:cs-1-approval-digest")
    expect(approved[0].digest).not.toBe("sha256:cs-1-list-digest")
    await waitFor(() => expect(rowFor("cs-1")).toHaveAttribute("data-row-state", "approved"))
  })

  it("rejects a plan inline and settles that row only", async () => {
    stubFetch({
      list: {
        changesets: [listRow("cs-1", { translationsAdded: 4 }), listRow("cs-2", { translationsAdded: 1 })],
        heldCount: 0,
        surfacedCap: 3,
      },
    })

    renderPage()
    await waitFor(() => expect(screen.getByTestId("approvals-queue")).toBeInTheDocument())
    await userEvent.click(within(rowFor("cs-1")).getByRole("button", { name: /reject/i }))

    await waitFor(() => expect(rowFor("cs-1")).toHaveAttribute("data-row-state", "rejected"))
    expect(rowFor("cs-2")).toHaveAttribute("data-row-state", "idle")
    expect(within(rowFor("cs-2")).getByRole("button", { name: /approve/i })).toBeEnabled()
  })

  it("excludes testimony plans from the bulk approve (COMMAND-REGISTRY §5)", async () => {
    const approved: string[] = []
    stubFetch({
      list: {
        changesets: [
          listRow("cs-prepared", {
            events: [{ kind: "target.cell.commit", count: 3 }],
          }),
          listRow("cs-testimony", {
            events: [{ kind: "cell.validate", count: 2, testimony: true }],
          }),
        ],
        heldCount: 0,
        surfacedCap: 3,
      },
      onApprove: (id) => {
        approved.push(id)
        return new Response(
          JSON.stringify({ confirmationId: `conf-${id}`, expiresAt: "2026-08-11T00:00:00.000Z" }),
          { status: 200 },
        )
      },
    })

    renderPage()
    await waitFor(() => expect(screen.getByTestId("approvals-queue")).toBeInTheDocument())

    // The button counts only what it may approve — one of the two rows.
    const bulk = screen.getByRole("button", { name: /approve 1 plan/i })
    expect(screen.getByText(/never approved in bulk/i)).toBeInTheDocument()
    expect(within(rowFor("cs-testimony")).getByText(/needs per-item review/i)).toBeInTheDocument()

    await userEvent.click(bulk)

    await waitFor(() => expect(screen.getByText(/approved 1 of 1/i)).toBeInTheDocument())
    expect(approved).toEqual(["cs-prepared"])
    expect(rowFor("cs-testimony")).toHaveAttribute("data-row-state", "idle")
  })

  it("keeps the rest of a bulk approve going when one plan fails, and says so", async () => {
    stubFetch({
      list: {
        changesets: [listRow("cs-1", { translationsAdded: 1 }), listRow("cs-2", { translationsAdded: 1 })],
        heldCount: 0,
        surfacedCap: 3,
      },
      onApprove: (id) =>
        id === "cs-1"
          ? new Response(
              JSON.stringify({ error: { code: "validation_failed", message: "changeset has expired" } }),
              { status: 409 },
            )
          : new Response(
              JSON.stringify({ confirmationId: "conf-2", expiresAt: "2026-08-11T00:00:00.000Z" }),
              { status: 200 },
            ),
    })

    renderPage()
    await waitFor(() => expect(screen.getByTestId("approvals-queue")).toBeInTheDocument())
    await userEvent.click(screen.getByRole("button", { name: /approve 2 plans/i }))

    await waitFor(() => expect(screen.getByText(/approved 1 of 2/i)).toBeInTheDocument())
    expect(rowFor("cs-1")).toHaveAttribute("data-row-state", "error")
    expect(rowFor("cs-2")).toHaveAttribute("data-row-state", "approved")
  })

  it("reports what the server held back rather than pretending the queue is complete", async () => {
    stubFetch({
      list: { changesets: [listRow("cs-1", { translationsAdded: 1 })], heldCount: 4, surfacedCap: 3 },
    })

    renderPage()

    await waitFor(() => expect(screen.getByTestId("approvals-queue")).toBeInTheDocument())
    expect(document.querySelector('[data-held-count="4"]')).not.toBeNull()
  })

  it("shows an empty queue rather than an error when nothing is staged", async () => {
    stubFetch({ list: { changesets: [], heldCount: 0, surfacedCap: 3 } })

    renderPage()

    expect(await screen.findByText(/nothing is waiting for approval/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /approve 0 plans/i })).toBeDisabled()
  })

  it("asks a signed-out reviewer to sign in instead of calling the API", async () => {
    sessionValue = { session: null, loading: false }
    const calls = stubFetch({ list: { changesets: [], heldCount: 0, surfacedCap: 3 } })

    renderPage()

    expect(await screen.findByText(/sign in to review this project's pending approvals/i)).toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it("surfaces a list failure as one message and keeps the page usable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/sync-token")) {
          return new Response(JSON.stringify(SYNC_TOKEN_BODY), { status: 200 })
        }
        return new Response(
          JSON.stringify({ error: { code: "permission_denied", message: "no project membership" } }),
          { status: 403 },
        )
      }),
    )

    renderPage()

    await waitFor(() =>
      expect(screen.queryByText(/loading pending approvals/i)).not.toBeInTheDocument(),
    )
    expect(screen.queryByTestId("approvals-queue")).not.toBeInTheDocument()
    // The keyed 403 copy, not the server's raw "no project membership".
    expect(screen.getByText(/aren't authorized/i)).toBeInTheDocument()
    expect(screen.queryByText(/no project membership/i)).not.toBeInTheDocument()
  })
})
