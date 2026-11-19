// DcsUpstreamPanel smoke test (Slice C).
//
// Focuses on the component's own contract, mocking the heavy modules its
// callbacks orchestrate (the Door43 revision loop, the files reader, the
// settings + session hooks). Two assertions carry the design intent:
//   1. "Check for updates" resolves a newer release and renders
//      "vOLD → vNEW, N files changed".
//   2. "Import changes" revises only the files changed between the two refs
//      that this project holds, and persists the advanced cursor via patch()
//      only when every revision landed. What a revision does to cells is the
//      route's contract (sync-worker revisions-route.test.ts) and the loop's
//      (src/lib/dcs/revision.test.ts).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { DcsUpstreamPanel } from "./DcsUpstreamPanel"
import type { DcsCatalogEntry, DcsCursor } from "@/lib/dcs/types"
import type { ReviseDcsArgs, ReviseDcsResult } from "@/lib/dcs/revision"

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
  fetchProjectFiles: vi.fn().mockResolvedValue([
    { fileId: "file-tit", name: "TIT" },
    { fileId: "file-trashed", name: "PHM", deletedAt: 5 },
  ]),
}))

// ── The revision loop — canned counts; the args are what the panel owns. ────

const cannedRevise: ReviseDcsResult = {
  created: 1,
  updated: 1,
  removed: 1,
  revisedFiles: 1,
  // AQU-1896: a run that changed something necessarily read something.
  scan: { heldFiles: 1, resolvedFiles: 1, fetchedFiles: 1 },
}
const unchanged = (scan: ReviseDcsResult["scan"]): ReviseDcsResult => ({ created: 0, updated: 0, removed: 0, revisedFiles: 0, scan })

const mockRevise = vi.fn(async (_args: ReviseDcsArgs): Promise<ReviseDcsResult> => cannedRevise)
vi.mock("@/lib/dcs/revision", async (i) => ({
  ...(await i<typeof import("@/lib/dcs/revision")>()),
  reviseDcsFiles: (args: ReviseDcsArgs) => mockRevise(args),
}))

/** The calls that would have written (a scan is a dry run). */
const writes = () => mockRevise.mock.calls.filter(([args]) => !args.dryRun)

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
    mockRevise.mockClear().mockResolvedValue(cannedRevise)
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

  it("Import changes revises the changed files this project holds and persists the advanced cursor", async () => {
    const client = makeClient(V89, ["57-TIT.usfm"])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /import changes/i })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /import changes/i }))

    await waitFor(() => expect(mockRevise).toHaveBeenCalledTimes(1))
    const args = mockRevise.mock.calls[0][0]
    // The NEW release is what gets read, narrowed to what changed since the pin.
    expect(args.entry).toMatchObject({ ref: "v89", commitSha: "new-sha" })
    expect(args.paths).toEqual(["57-TIT.usfm"])
    expect(args.projectId).toBe("adapter-1")
    // A file in Trash is not held: an update must not write into it.
    expect([...args.heldFileIds]).toEqual(["file-tit"])
    // An update is a real write, and not a same-artifact re-parse.
    expect(args.dryRun).toBeUndefined()
    expect(args.repair).toBeUndefined()

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

  it("does NOT advance the cursor when a revision fails part-way", async () => {
    // Advancing the pin here would be the damaging outcome: the next "Check
    // for updates" would compare against a release this project never fully
    // received, and the files that did not land would never be offered again.
    mockRevise.mockRejectedValue(new Error("Revision upload failed (HTTP 500)"))
    const client = makeClient(V89, ["57-TIT.usfm"])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /import changes/i })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /import changes/i }))

    await waitFor(() => {
      expect(screen.getByText(/HTTP 500/i)).toBeInTheDocument()
    })
    expect(mockPatch).not.toHaveBeenCalled()
    expect(screen.queryByText(/1 created, 1 updated, 1 removed/i)).not.toBeInTheDocument()
  })

  it("Re-sync content SCANS first: shows counts and emits NOTHING until confirmed", async () => {
    // One-click tombstoning was the adversarial-review blocker: a repair's
    // removals hide translations, so the scan must be side-effect free and the
    // apply gated behind an explicit confirm.
    const pinnedEntry = { ...V89, ref: "v88", commitSha: "old-sha" }
    const client = makeClient(V89, [], pinnedEntry)
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)

    fireEvent.click(screen.getByRole("button", { name: /re-sync content/i }))

    await waitFor(() => expect(mockRevise).toHaveBeenCalledTimes(1))
    // Repair reads the PINNED entry, never the latest release, re-reads every
    // held member (no changed-files narrowing), and the scan is a dry run.
    expect(mockRevise.mock.calls[0][0]).toMatchObject({
      entry: expect.objectContaining({ ref: "v88", commitSha: "old-sha" }),
      repair: true,
      dryRun: true,
    })
    expect(mockRevise.mock.calls[0][0].paths).toBeUndefined()

    // Counts surface (1 to repair, 1 new, 1 to remove in the canned result)…
    await waitFor(() => {
      expect(screen.getByText(/1 to repair,\s*1 new,\s*1 to remove/i)).toBeInTheDocument()
    })
    // …the removal is called out specifically…
    expect(
      screen.getAllByText(/will be removed — translations attached to (them|removed cells) will be hidden/i).length,
    ).toBeGreaterThan(0)
    // …and NOTHING has been written yet.
    expect(writes()).toHaveLength(0)

    // Cancelling the confirm dialog also applies nothing.
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(writes()).toHaveLength(0)
  })

  it("Re-sync confirm writes the scanned repair against the same pin, without advancing the cursor", async () => {
    const pinnedEntry = { ...V89, ref: "v88", commitSha: "old-sha" }
    const client = makeClient(V89, [], pinnedEntry)
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)

    fireEvent.click(screen.getByRole("button", { name: /re-sync content/i }))
    await waitFor(() => expect(mockRevise).toHaveBeenCalledTimes(1))

    // Confirm dialog: checkbox-gated destructive confirm (same idiom as detach).
    const confirmButton = await screen.findByRole("button", { name: /^apply re-sync$/i })
    expect(confirmButton).toBeDisabled()
    fireEvent.click(screen.getByText(/I understand removed cells hide their translations/i))
    expect(confirmButton).toBeEnabled()
    fireEvent.click(confirmButton)

    await waitFor(() => expect(writes()).toHaveLength(1))
    // The apply step re-read the settings cursor before writing.
    expect(mockRefresh).toHaveBeenCalled()
    // Same pinned entry as the scan, and `repair` is what lets the route align
    // an artifact the head already names — without it every file is a no-op.
    expect(writes()[0][0]).toMatchObject({
      entry: expect.objectContaining({ ref: "v88", commitSha: "old-sha" }),
      repair: true,
    })

    // Summary: 1 new + 1 repaired + 1 removed = 3 repaired cells.
    await waitFor(() => {
      expect(screen.getByText(/repaired 3 cells/i)).toBeInTheDocument()
    })
    // The pin did NOT move — repair never advances the cursor.
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it("Re-sync content reports 'already matches' when the repair changes nothing AND the scan read something", async () => {
    // AQU-1896: the reassuring copy is earned by a scan that actually re-read
    // the project's files. Zero ops alone no longer buys it.
    mockRevise.mockResolvedValue(unchanged({ heldFiles: 2, resolvedFiles: 2, fetchedFiles: 2 }))
    const client = makeClient(V89, [])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)
    fireEvent.click(screen.getByRole("button", { name: /re-sync content/i }))
    await waitFor(() => {
      expect(screen.getByText(/everything already matches/i)).toBeInTheDocument()
    })
    expect(writes()).toHaveLength(0)
  })

  it("Re-sync content that resolved NONE of the project's files says so instead of claiming a match (AQU-1896)", async () => {
    // The state the QA bot hit: the project's file ids could not be derived
    // from any upstream path, so no book was fetched — and the panel reported
    // that everything matched. The op counts are identical to the healthy
    // case; only the scan distinguishes them.
    mockRevise.mockResolvedValue(unchanged({ heldFiles: 3, resolvedFiles: 0, fetchedFiles: 0 }))
    const client = makeClient(V89, [])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)
    fireEvent.click(screen.getByRole("button", { name: /re-sync content/i }))

    await waitFor(() => {
      expect(screen.getByText(/nothing was checked/i)).toBeInTheDocument()
    })
    // It names what it could not find, with the count it tried.
    expect(screen.getByText(/none of this project's 3 source files/i)).toBeInTheDocument()
    // And it must NOT claim a match.
    expect(screen.queryByText(/everything already matches/i)).not.toBeInTheDocument()
    expect(writes()).toHaveLength(0)
  })

  it("Re-sync content whose resolved paths are no longer served names that cause, not a match (AQU-1896)", async () => {
    // The legitimate variant: the pinned tree still lists the held paths but
    // the ref no longer serves them, so again nothing was compared.
    mockRevise.mockResolvedValue(unchanged({ heldFiles: 2, resolvedFiles: 2, fetchedFiles: 0 }))
    const client = makeClient(V89, [])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)
    fireEvent.click(screen.getByRole("button", { name: /re-sync content/i }))

    await waitFor(() => {
      expect(screen.getByText(/no longer serves/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/nothing was checked/i)).toBeInTheDocument()
    expect(screen.queryByText(/everything already matches/i)).not.toBeInTheDocument()
  })

  it("a DCS project holding no source cells at all still reads as in sync, not as an alarm (AQU-1896)", async () => {
    // Nothing held means nothing to check and no false claim about files the
    // scan failed to reach — the reassuring copy stays correct here.
    mockRevise.mockResolvedValue(unchanged({ heldFiles: 0, resolvedFiles: 0, fetchedFiles: 0 }))
    const client = makeClient(V89, [])
    render(<DcsUpstreamPanel projectId="adapter-1" roleLevel={600} client={client} />)
    fireEvent.click(screen.getByRole("button", { name: /re-sync content/i }))
    await waitFor(() => {
      expect(screen.getByText(/everything already matches/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/nothing was checked/i)).not.toBeInTheDocument()
  })

  it("Re-sync apply ABORTS without events when the cursor vanished between confirm and apply (detach race)", async () => {
    // Another tab detaches the project while the confirm dialog is open. The
    // apply step re-reads the settings cursor via refresh() and must abort —
    // applying would write into a detached project.
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
    expect(writes()).toHaveLength(0)
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
    expect(writes()).toHaveLength(0)
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
    expect(writes()).toHaveLength(0)

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
