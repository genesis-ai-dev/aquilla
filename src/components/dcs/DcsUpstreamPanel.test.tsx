// DcsUpstreamPanel smoke test (Slice C).
//
// Focuses on the component's own contract, mocking the heavy modules its
// callbacks orchestrate (the delta engine, the cells reader, the settings +
// session hooks). Two assertions carry the design intent:
//   1. "Check for updates" resolves a newer release and renders
//      "vOLD → vNEW, N files changed".
//   2. "Import changes" runs applyDelta with REAL source emitters — i.e. the
//      emitters passed to applyDelta actually invoke emitSourceCellCommit /
//      emitSourceCellDelete / the source.cell.create enqueue path, and the
//      advanced cursor is persisted via patch().

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
let settingsBag: Record<string, unknown>
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({ settings: settingsBag, patch: mockPatch }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt-1", username: "maintainer1" } }),
}))

// Token fetcher — always resolves a token.
vi.mock("@/lib/sync/cqrs-bridge", () => ({
  buildFileScopedTokenFetcher: () => async () => "jwt-token",
}))

// ── Reads ───────────────────────────────────────────────────────────────────

vi.mock("@/lib/sync/cells-read", () => ({
  fetchProjectFiles: vi.fn().mockResolvedValue([{ fileId: "file-tit", name: "TIT" }]),
  fetchAllFileCells: vi.fn().mockResolvedValue([
    { cellId: "TIT-1-1", value: "old verse 1", eventId: "src-head-1" },
  ]),
}))

// ── Emitters (the "real emitters" applyDelta must call) ─────────────────────

const mockEmitCommit = vi.fn().mockResolvedValue("commit-evt")
const mockEmitDelete = vi.fn().mockResolvedValue("delete-evt")
const mockEnqueue = vi.fn().mockResolvedValue({ event: {}, eventId: "create-evt" })
vi.mock("@/lib/sync/events-emit", () => ({
  emitSourceCellCommit: (...a: unknown[]) => mockEmitCommit(...a),
  emitSourceCellDelete: (...a: unknown[]) => mockEmitDelete(...a),
  enqueueEvent: (...a: unknown[]) => mockEnqueue(...a),
}))

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
    mockEmitCommit.mockClear().mockResolvedValue("commit-evt")
    mockEmitDelete.mockClear().mockResolvedValue("delete-evt")
    mockEnqueue.mockClear().mockResolvedValue({ event: {}, eventId: "create-evt" })
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

    // applyDelta was handed REAL emitters — invoking them fired the real
    // typed source emit helpers (commit chained on the head, delete, create).
    expect(mockEmitCommit).toHaveBeenCalledTimes(1)
    expect(mockEmitCommit.mock.calls[0][0]).toMatchObject({
      cellId: "TIT-1-1",
      parentId: "src-head-1",
      value: "new verse 1",
    })
    expect(mockEmitDelete).toHaveBeenCalledTimes(1)
    expect(mockEmitDelete.mock.calls[0][0]).toMatchObject({ cellId: "TIT-1-9" })
    // create goes through enqueueEvent with kind source.cell.create.
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    // fileId MUST be the parsed file's id, not the cell id — a create is absent
    // from currentCells, so the old `fileIdByCellId.get() ?? cell.cellId` fallback
    // orphaned new cells into a phantom file. Guard that regression here.
    expect(mockEnqueue.mock.calls[0][0]).toMatchObject({
      kind: "source.cell.create",
      cellId: "TIT-1-3",
      fileId: "file-57-TIT",
    })
    expect(mockEnqueue.mock.calls[0][0].fileId).not.toBe("TIT-1-3")

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

  it("Re-sync content repairs the pinned import via the SAME apply path, without advancing the cursor", async () => {
    // Repair targets the PINNED ref, so getCatalogEntry resolves the cursor's
    // own entry (v88 / old-sha) — pass it as oldEntry.
    const pinnedEntry = { ...V89, ref: "v88", commitSha: "old-sha" }
    const client = makeClient(V89, [], pinnedEntry)
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)

    // The quiet secondary action is present for a pinned adapter project.
    fireEvent.click(screen.getByRole("button", { name: /re-sync content/i }))

    await waitFor(() => {
      expect(mockComputeRepairDelta).toHaveBeenCalledTimes(1)
    })
    // Repair reads the PINNED entry, never the latest release.
    expect(mockComputeRepairDelta.mock.calls[0][0]).toMatchObject({
      entry: expect.objectContaining({ ref: "v88", commitSha: "old-sha" }),
    })

    // Applied through the SAME applyDelta path with the REAL emitters wired.
    await waitFor(() => expect(mockApplyDelta).toHaveBeenCalledTimes(1))
    expect(mockEmitCommit).toHaveBeenCalledTimes(1)
    expect(mockEmitCommit.mock.calls[0][0]).toMatchObject({
      cellId: "TIT-1-1",
      parentId: "src-head-1",
      value: "new verse 1",
    })
    expect(mockEmitDelete).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue.mock.calls[0][0]).toMatchObject({
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
    expect(mockEmitCommit).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
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
    expect(mockEmitCommit).not.toHaveBeenCalled()
    expect(mockEmitDelete).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()

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
