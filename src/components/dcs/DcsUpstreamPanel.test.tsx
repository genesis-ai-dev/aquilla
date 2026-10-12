// DcsUpstreamPanel smoke test (Slice C).
//
// Focuses on the component's own contract, mocking the heavy modules its
// callbacks orchestrate (the delta engine, the cells reader, the settings +
// session hooks). Two assertions carry the design intent:
//   1. "Check for updates" resolves a newer release and renders
//      "vOLD → vNEW, N files changed".
//   2. "Import changes" runs applyDelta with REAL source emitters — i.e. the
//      emitters passed to applyDelta build genuine source.cell.create /
//      .commit / .delete envelopes, those go out through the BULK commit path
//      (AQU-1860, not one outbox row per cell), and the advanced cursor is
//      persisted via patch().

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { DcsUpstreamPanel } from "./DcsUpstreamPanel"
import type { DcsCatalogEntry, DcsCursor } from "@/lib/dcs/types"
import type { DeltaResult, DeltaEmitters } from "@/lib/dcs/delta"

// ── Session + settings hooks ────────────────────────────────────────────────

const CURSOR: DcsCursor = {
  owner: "unfoldingWord",
  repo: "en_ult",
  subject: "Aligned Bible",
  contentFormat: "usfm",
  trackMode: "release",
  ref: "v88",
  commitSha: "old-sha",
  released: "2026-05-01T00:00:00Z",
  importedAt: "2026-05-02T00:00:00Z",
}

const mockPatch = vi.fn()
// refresh() re-GETs the server settings row — the repair-apply step re-checks
// the cursor through it. Defaults to serving the live settingsBag.
const mockRefresh = vi.fn()
let settingsBag: Record<string, unknown>
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({ settings: settingsBag, patch: mockPatch, refresh: mockRefresh }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt-1", username: "maintainer1" } }),
}))

// Token fetcher — always resolves a token.
vi.mock("@/lib/sync/cqrs-bridge", () => ({
  buildFileScopedTokenFetcher: () => async () => "jwt-token",
  // events-emit reads this for its client-side role mirror. null = unknown
  // role, which fails open (the server stays authoritative).
  getCqrsOutboxBridge: () => null,
}))

// ── Reads ───────────────────────────────────────────────────────────────────

vi.mock("@/lib/sync/cells-read", () => ({
  fetchProjectFiles: vi.fn().mockResolvedValue([{ fileId: "file-tit", name: "TIT" }]),
  fetchAllFileCells: vi.fn().mockResolvedValue([
    { cellId: "TIT-1-1", value: "old verse 1", eventId: "src-head-1" },
  ]),
}))

// ── Bulk commit (AQU-1860) ─────────────────────────────────────────────────
//
// applyDelta's emitters no longer write one outbox row per cell; they build
// real envelopes with `buildRawEvent` (left unmocked — it is pure) and the
// whole delta is handed to `bulkPostEvents` in one call. Capturing that call is
// what proves the wiring, so the per-kind assertions below read the envelopes.

type BulkOutcome = {
  posted: number
  rejected: Array<{ id: string; status: number; reason: string }>
  stale: Array<{ id: string; fileId: string | null; cellId: string | null }>
}

const mockBulkPostEvents = vi.fn(
  async (_arg: { events: PostedEvent[] }): Promise<BulkOutcome> => ({
    posted: 0,
    rejected: [],
    stale: [],
  }),
)
vi.mock("@/lib/sync/bulk-events", () => ({
  bulkPostEvents: (arg: unknown) => mockBulkPostEvents(arg as { events: PostedEvent[] }),
}))

type PostedEvent = {
  kind: string
  cellId?: string
  fileId?: string
  parentId: string | null
  payload: Record<string, unknown>
}

/** The envelopes handed to the single bulkPostEvents call, by kind. */
function postedEvents(): PostedEvent[] {
  expect(mockBulkPostEvents).toHaveBeenCalledTimes(1)
  return mockBulkPostEvents.mock.calls[0][0].events
}

function postedOfKind(kind: string): PostedEvent[] {
  return postedEvents().filter((event) => event.kind === kind)
}

// ── Delta engine — computeDelta returns a canned result; applyDelta is a spy
//    that ACTUALLY invokes the passed emitters so we prove the wiring. ────────

const cannedDelta: DeltaResult = {
  creates: [
    {
      cell: { cellId: "TIT-1-3", value: "new verse 3", type: "verse", contentHash: "aaaa1111" },
      fileId: "file-57-TIT",
    },
  ],
  commits: [
    {
      cell: { cellId: "TIT-1-1", value: "new verse 1", type: "verse", contentHash: "bbbb2222" },
      parentEventId: "src-head-1",
    },
  ],
  deletes: ["TIT-1-9"],
}

const mockComputeDelta = vi.fn().mockResolvedValue(cannedDelta)
const mockComputeRepairDelta = vi.fn().mockResolvedValue(cannedDelta)
const mockApplyDelta = vi.fn(
  async (delta: DeltaResult, emitters: DeltaEmitters, ctx: { repo: string; sha: string }) => {
    for (const { cell, fileId } of delta.creates) {
      await emitters.create({ cellId: cell.cellId, eventId: `ev-${cell.cellId}`, cell, fileId })
    }
    for (const { cell, parentEventId } of delta.commits) {
      await emitters.commit({ cellId: cell.cellId, eventId: `ev-${cell.cellId}`, parentEventId, cell })
    }
    for (const cellId of delta.deletes) {
      await emitters.delete({ cellId })
    }
    void ctx
  },
)
vi.mock("@/lib/dcs/delta", async (i) => ({
  ...(await i<typeof import("@/lib/dcs/delta")>()),
  computeDelta: (arg: unknown) => mockComputeDelta(arg),
  computeRepairDelta: (arg: unknown) => mockComputeRepairDelta(arg),
  applyDelta: (delta: DeltaResult, emitters: DeltaEmitters, ctx: { repo: string; sha: string }) =>
    mockApplyDelta(delta, emitters, ctx),
}))

// ── DcsClient — inject via prop so no network. ──────────────────────────────

const V89: DcsCatalogEntry = {
  name: "en_ult",
  owner: "unfoldingWord",
  fullName: "unfoldingWord/en_ult",
  subject: "Aligned Bible",
  contentFormat: "usfm",
  ref: "v89",
  refType: "tag",
  commitSha: "new-sha",
  released: "2026-06-23T00:00:00Z",
  zipballUrl: "",
  metadataUrl: "",
  language: "en",
}

// `latest` is what getLatestRelease resolves (the newest prod release — this is
// what "Check for updates" now compares against, per DEFECT 3). `oldEntry` is
// what getCatalogEntry resolves for the cursor's pinned ref (used by handleImport
// for the delta's old side). Defaulting oldEntry to `latest` keeps existing
// tests behaving, but the up-to-date case passes a distinct pinned entry.
function makeClient(
  latest: DcsCatalogEntry,
  changedFiles: string[],
  oldEntry: DcsCatalogEntry = latest,
) {
  return {
    getLatestRelease: vi.fn().mockResolvedValue(latest),
    getCatalogEntry: vi.fn().mockResolvedValue(oldEntry),
    compareRefs: vi.fn().mockResolvedValue({ totalCommits: 3, changedFiles }),
  } as unknown as import("@/lib/dcs/catalog").DcsClient
}

describe("DcsUpstreamPanel", () => {
  beforeEach(() => {
    settingsBag = { dcsUpstream: CURSOR }
    mockPatch.mockClear().mockResolvedValue({ kind: "ok" })
    mockRefresh.mockClear().mockImplementation(async () => ({
      version: 1,
      updatedAt: "2026-07-01T00:00:00Z",
      updatedBy: null,
      settings: settingsBag,
    }))
    mockBulkPostEvents.mockClear().mockResolvedValue({ posted: 0, rejected: [], stale: [] })
    mockComputeDelta.mockClear().mockResolvedValue(cannedDelta)
    mockComputeRepairDelta.mockClear().mockResolvedValue(cannedDelta)
    mockApplyDelta.mockClear()
  })

  it("renders nothing when the project has no dcsUpstream cursor", () => {
    settingsBag = {}
    const { container } = render(
      <DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={makeClient(V89, [])} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("Check for updates resolves the LATEST prod release and shows an update when it's NEWER than the cursor (DEFECT 3)", async () => {
    // The cursor is pinned at v88; the current prod release is v89 (a NEW tag,
    // not a moved one). The old bug re-fetched the pinned ref's own entry and
    // always reported "up to date". The panel must resolve the latest release
    // (getLatestRelease) and surface the available update.
    const client = makeClient(V89, ["57-TIT.usfm", "58-PHM.usfm"])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }))

    await waitFor(() => {
      expect(screen.getByText(/v88\s*→\s*v89,\s*2\s*files changed/i)).toBeInTheDocument()
    })
    // It resolved the latest release rather than re-fetching the pinned ref.
    const c = client as unknown as { getLatestRelease: ReturnType<typeof vi.fn> }
    expect(c.getLatestRelease).toHaveBeenCalledWith("unfoldingWord", "en_ult")
    // NOT "up to date" — the whole DEFECT-3 point.
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument()
  })

  it("shows up-to-date when the LATEST prod release equals the cursor (DEFECT 3)", async () => {
    // Latest prod release == the pinned cursor (same ref + sha) → truly current.
    const sameEntry = { ...V89, ref: "v88", commitSha: "old-sha" }
    const client = makeClient(sameEntry, [])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)
    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }))
    await waitFor(() => {
      expect(screen.getByText(/up to date/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/files changed/i)).not.toBeInTheDocument()
  })

  it("Import changes runs applyDelta with real emitters and persists the advanced cursor", async () => {
    const client = makeClient(V89, ["57-TIT.usfm"])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /import changes/i })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /import changes/i }))

    await waitFor(() => {
      expect(mockApplyDelta).toHaveBeenCalledTimes(1)
    })

    // applyDelta was handed REAL emitters — invoking them built genuine source
    // envelopes (commit chained on the head, delete, create), and the whole
    // delta went out in ONE bulk commit rather than one outbox row per cell
    // (AQU-1860).
    const commits = postedOfKind("source.cell.commit")
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({
      cellId: "TIT-1-1",
      parentId: "src-head-1",
      payload: { value: "new verse 1" },
    })
    const deletes = postedOfKind("source.cell.delete")
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toMatchObject({ cellId: "TIT-1-9" })
    const creates = postedOfKind("source.cell.create")
    expect(creates).toHaveLength(1)
    // fileId MUST be the parsed file's id, not the cell id — a create is absent
    // from currentCells, so the old `fileIdByCellId.get() ?? cell.cellId` fallback
    // orphaned new cells into a phantom file. Guard that regression here.
    expect(creates[0]).toMatchObject({
      kind: "source.cell.create",
      cellId: "TIT-1-3",
      fileId: "file-57-TIT",
    })
    expect(creates[0].fileId).not.toBe("TIT-1-3")
    // A genesis kind must carry a null parent; the commit's parent is the head.
    expect(creates[0].parentId).toBeNull()

    // applyDelta's ctx uses the destination projectId + the new release's
    // fullName + sha — projectId scopes the deterministic event ids so the same
    // resource delta'd into two projects never collides on the events PK (DEFECT 4).
    expect(mockApplyDelta.mock.calls[0][2]).toEqual({
      projectId: "adapter-1",
      repo: "unfoldingWord/en_ult",
      sha: "new-sha",
    })

    // The advanced cursor was persisted under the dcsUpstream key.
    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledTimes(1)
    })
    const patchArg = mockPatch.mock.calls[0][0] as Record<string, DcsCursor>
    expect(patchArg.dcsUpstream.ref).toBe("v89")
    expect(patchArg.dcsUpstream.commitSha).toBe("new-sha")

    // Summary surfaces created/updated/removed counts.
    await waitFor(() => {
      expect(screen.getByText(/1 created, 1 updated, 1 removed/i)).toBeInTheDocument()
    })
  })

  it("does NOT advance the cursor when the server refused part of the delta", async () => {
    // AQU-1860: the bulk path has no outbox behind it, so a partial commit is
    // the panel's to report. Advancing the pin here would be the damaging
    // outcome: the next "Check for updates" would compare against a release
    // this project never fully received, and the missing cells would never be
    // offered again.
    mockBulkPostEvents.mockResolvedValue({
      posted: 3,
      rejected: [],
      stale: [{ id: "ev-TIT-1-1", fileId: "file-tit", cellId: "TIT-1-1" }],
    })
    const client = makeClient(V89, ["57-TIT.usfm"])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /import changes/i })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /import changes/i }))

    await waitFor(() => expect(mockBulkPostEvents).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(screen.getByText(/could not be applied/i)).toBeInTheDocument()
    })
    expect(mockPatch).not.toHaveBeenCalled()
    expect(screen.queryByText(/1 created, 1 updated, 1 removed/i)).not.toBeInTheDocument()
  })

  it("Re-sync content SCANS first: shows counts and emits NOTHING until confirmed", async () => {
    // One-click tombstoning was the adversarial-review blocker: computeRepairDelta
    // deletes hide translations, so the scan must be side-effect free and the
    // apply gated behind an explicit confirm.
    const pinnedEntry = { ...V89, ref: "v88", commitSha: "old-sha" }
    const client = makeClient(V89, [], pinnedEntry)
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)

    fireEvent.click(screen.getByRole("button", { name: /re-sync content/i }))

    await waitFor(() => expect(mockComputeRepairDelta).toHaveBeenCalledTimes(1))
    // Repair reads the PINNED entry, never the latest release.
    expect(mockComputeRepairDelta.mock.calls[0][0]).toMatchObject({
      entry: expect.objectContaining({ ref: "v88", commitSha: "old-sha" }),
    })

    // Counts surface (1 commit to repair, 1 create, 1 delete in the canned delta)…
    await waitFor(() => {
      expect(screen.getByText(/1 to repair,\s*1 new,\s*1 to remove/i)).toBeInTheDocument()
    })
    // …the removal is called out specifically…
    expect(
      screen.getAllByText(/will be removed — translations attached to (them|removed cells) will be hidden/i).length,
    ).toBeGreaterThan(0)
    // …and NOTHING has been emitted or applied yet.
    expect(mockApplyDelta).not.toHaveBeenCalled()
    expect(mockBulkPostEvents).not.toHaveBeenCalled()

    // Cancelling the confirm dialog also applies nothing.
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(mockApplyDelta).not.toHaveBeenCalled()
  })

  it("Re-sync confirm applies the SCANNED delta via the SAME apply path, without advancing the cursor", async () => {
    const pinnedEntry = { ...V89, ref: "v88", commitSha: "old-sha" }
    const client = makeClient(V89, [], pinnedEntry)
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)

    fireEvent.click(screen.getByRole("button", { name: /re-sync content/i }))
    await waitFor(() => expect(mockComputeRepairDelta).toHaveBeenCalledTimes(1))

    // Confirm dialog: checkbox-gated destructive confirm (same idiom as detach).
    const confirmButton = await screen.findByRole("button", { name: /^apply re-sync$/i })
    expect(confirmButton).toBeDisabled()
    fireEvent.click(screen.getByText(/I understand removed cells hide their translations/i))
    expect(confirmButton).toBeEnabled()
    fireEvent.click(confirmButton)

    // Applied through the SAME applyDelta path with the REAL emitters wired.
    await waitFor(() => expect(mockApplyDelta).toHaveBeenCalledTimes(1))
    // The apply step re-read the settings cursor before emitting.
    expect(mockRefresh).toHaveBeenCalled()
    const repairCommits = postedOfKind("source.cell.commit")
    expect(repairCommits).toHaveLength(1)
    expect(repairCommits[0]).toMatchObject({
      cellId: "TIT-1-1",
      parentId: "src-head-1",
      payload: { value: "new verse 1" },
    })
    expect(postedOfKind("source.cell.delete")).toHaveLength(1)
    const repairCreates = postedOfKind("source.cell.create")
    expect(repairCreates).toHaveLength(1)
    expect(repairCreates[0]).toMatchObject({
      kind: "source.cell.create",
      fileId: "file-57-TIT",
    })

    // The revision token is NOT the bare pinned sha — the original import
    // already minted event ids there; a bare-sha repair would be silently
    // dropped by the server's idempotent event PK.
    const ctx = mockApplyDelta.mock.calls[0][2] as { projectId: string; repo: string; sha: string }
    expect(ctx.repo).toBe("unfoldingWord/en_ult")
    expect(ctx.sha).toMatch(/^old-sha#repair-/)

    // Summary: 1 create + 1 commit + 1 delete = 3 repaired cells.
    await waitFor(() => {
      expect(screen.getByText(/repaired 3 cells/i)).toBeInTheDocument()
    })
    // The pin did NOT move — repair never advances the cursor.
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it("Re-sync content reports 'already matches' when the repair delta is empty", async () => {
    mockComputeRepairDelta.mockResolvedValue({ creates: [], commits: [], deletes: [] })
    const client = makeClient(V89, [])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)
    fireEvent.click(screen.getByRole("button", { name: /re-sync content/i }))
    await waitFor(() => {
      expect(screen.getByText(/everything already matches/i)).toBeInTheDocument()
    })
    expect(mockBulkPostEvents).not.toHaveBeenCalled()
  })

  it("Re-sync apply ABORTS without events when the cursor vanished between confirm and apply (detach race)", async () => {
    // Another tab detaches the project while the confirm dialog is open. The
    // apply step re-reads the settings cursor via refresh() and must abort —
    // applying the stale delta would write into a detached project.
    const pinnedEntry = { ...V89, ref: "v88", commitSha: "old-sha" }
    const client = makeClient(V89, [], pinnedEntry)
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)

    fireEvent.click(screen.getByRole("button", { name: /re-sync content/i }))
    const confirmButton = await screen.findByRole("button", { name: /^apply re-sync$/i })

    // The other tab detaches NOW — the next refresh serves no cursor.
    mockRefresh.mockResolvedValue({
      version: 2, updatedAt: "2026-07-02T00:00:00Z", updatedBy: null,
      settings: { dcsUpstream: null },
    })

    fireEvent.click(screen.getByText(/I understand removed cells hide their translations/i))
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(screen.getByText(/upstream link changed .* nothing was applied/i)).toBeInTheDocument()
    })
    expect(mockApplyDelta).not.toHaveBeenCalled()
    expect(mockBulkPostEvents).not.toHaveBeenCalled()
  })

  it("Re-sync apply ABORTS when the cursor's commitSha changed between confirm and apply (import race)", async () => {
    const pinnedEntry = { ...V89, ref: "v88", commitSha: "old-sha" }
    const client = makeClient(V89, [], pinnedEntry)
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)

    fireEvent.click(screen.getByRole("button", { name: /re-sync content/i }))
    const confirmButton = await screen.findByRole("button", { name: /^apply re-sync$/i })

    // Another tab imported v89 while the dialog sat open — the pin moved.
    mockRefresh.mockResolvedValue({
      version: 2, updatedAt: "2026-07-02T00:00:00Z", updatedBy: null,
      settings: { dcsUpstream: { ...CURSOR, ref: "v89", commitSha: "new-sha" } },
    })

    fireEvent.click(screen.getByText(/I understand removed cells hide their translations/i))
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(screen.getByText(/upstream link changed .* nothing was applied/i)).toBeInTheDocument()
    })
    expect(mockApplyDelta).not.toHaveBeenCalled()
    expect(mockBulkPostEvents).not.toHaveBeenCalled()
  })

  it("hides Re-sync content below maintainer (600)", () => {
    const client = makeClient(V89, [])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={500} client={client} />)
    expect(screen.queryByRole("button", { name: /re-sync content/i })).not.toBeInTheDocument()
  })

  it("hides Detach from upstream below maintainer (600)", () => {
    const client = makeClient(V89, [])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={500} client={client} />)
    expect(screen.queryByRole("button", { name: /detach from upstream/i })).not.toBeInTheDocument()
  })

  it("Detach: confirm flow persists dcsUpstream removal (null) and the panel unlinks", async () => {
    // The detach write must go through the settings patch with the dcsUpstream
    // key EXPLICITLY nulled — patch merges shallowly, so omitting the key would
    // leave the pin in place. readCursor(null) reads as absent, so after the
    // settings round-trip the panel renders its no-cursor state and
    // canEditSource unlocks via useDcsUpstreamCursor.
    mockPatch.mockImplementation(async (partial: Record<string, unknown>) => {
      settingsBag = { ...settingsBag, ...partial }
      return { kind: "ok" }
    })
    const client = makeClient(V89, [])
    const { container, rerender } = render(
      <DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />,
    )

    fireEvent.click(screen.getByRole("button", { name: /detach from upstream/i }))

    // Confirm dialog states exactly what happens, gated behind a checkbox.
    expect(
      screen.getByText(
        /stop receiving updates from unfoldingWord\/en_ult\. Source cells become editable\. This cannot be undone from here — relinking requires a fresh import\./i,
      ),
    ).toBeInTheDocument()
    const confirmButton = screen.getByRole("button", { name: /^detach$/i })
    expect(confirmButton).toBeDisabled()
    // Click the label text: happy-dom re-dispatches label-wrapped clicks back
    // onto the control, so clicking the checkbox itself double-toggles there.
    fireEvent.click(screen.getByText(/I understand this permanently unlinks/i))
    expect(confirmButton).toBeEnabled()
    fireEvent.click(confirmButton)

    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1))
    expect(mockPatch.mock.calls[0][0]).toEqual({ dcsUpstream: null })

    // No source events were emitted — detach only rewrites settings.
    expect(mockBulkPostEvents).not.toHaveBeenCalled()

    // The settings hook now serves the nulled bag → no-cursor state (nothing).
    rerender(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it("Detach: cancelling the confirm dialog persists nothing", () => {
    const client = makeClient(V89, [])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)
    fireEvent.click(screen.getByRole("button", { name: /detach from upstream/i }))
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(mockPatch).not.toHaveBeenCalled()
    // Still linked (badge + detach caption both still render the repo).
    expect(screen.getAllByText(/unfoldingWord\/en_ult/).length).toBeGreaterThan(0)
  })

  it("disables Import changes below maintainer (600)", async () => {
    const client = makeClient(V89, ["57-TIT.usfm"])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={500} client={client} />)
    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }))
    await waitFor(() => {
      expect(screen.getByText(/maintainer or above required/i)).toBeInTheDocument()
    })
    expect(screen.queryByRole("button", { name: /import changes/i })).not.toBeInTheDocument()
  })
})
