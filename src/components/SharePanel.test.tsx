// AQU-538 (Slice 5, wiring): SharePanel builds MembersPanelScopeConfig and
// hands it to MembersPanel only for callers who can manage scopes
// (callerMaxRole >= project_lead / 500). MembersPanel itself is mocked so
// these tests assert exactly what reaches it, not its internal rendering
// (that's covered by MembersPanel's own concerns / manual QA).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, waitFor } from "@testing-library/react"
import { SharePanel } from "./SharePanel"
import type { MembersPanelScopeConfig } from "./MembersPanel"

// ─── Mocks ────────────────────────────────────────────────────────────────

let lastMembersPanelProps:
  | { scopeConfig?: MembersPanelScopeConfig; canAddMembers?: boolean }
  | null = null

vi.mock("./MembersPanel", () => ({
  MembersPanel: (props: { scopeConfig?: MembersPanelScopeConfig; canAddMembers?: boolean }) => {
    lastMembersPanelProps = props
    return null
  },
}))

const leadMembers = [
  { userId: 1, username: "alice", role: { level: 500, name: "project_lead", source: "override" as const }, secondarySources: [] },
  { userId: 2, username: "bob", role: { level: 400, name: "contributor", source: "override" as const }, secondarySources: [] },
]

const contributorMembers = [
  { userId: 1, username: "alice", role: { level: 400, name: "contributor", source: "override" as const }, secondarySources: [] },
  { userId: 2, username: "bob", role: { level: 300, name: "reviewer", source: "override" as const }, secondarySources: [] },
]

let mockMembers = leadMembers

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: mockMembers,
    isLoading: false,
    error: null,
    rosterHidden: false,
    refresh: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    changeRole: vi.fn(),
  }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "test-jwt", username: "alice" },
  }),
}))

vi.mock("@/lib/sync/invites", () => ({
  createServerInvite: vi.fn(),
  listProjectInvites: vi.fn().mockResolvedValue([]),
  revokeProjectInvite: vi.fn(),
}))

const mockFetchProjectSettings = vi.fn()
vi.mock("@/lib/sync/project-settings", () => ({
  fetchProjectSettings: (...args: unknown[]) => mockFetchProjectSettings(...args),
}))

const mockResolveCloudProjectResult = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({
  resolveCloudProjectResult: (...args: unknown[]) => mockResolveCloudProjectResult(...args),
}))

const mockFetchMemberScopes = vi.fn()
const mockPutMemberScopes = vi.fn()
vi.mock("@/lib/sync/member-scopes", () => ({
  fetchMemberScopes: (...args: unknown[]) => mockFetchMemberScopes(...args),
  putMemberScopes: (...args: unknown[]) => mockPutMemberScopes(...args),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────

function renderPanel(projectId = "proj-1", canManageMembers?: boolean) {
  return render(
    <SharePanel
      open={true}
      onOpenChange={() => {}}
      projectId={projectId}
      canManageMembers={canManageMembers}
    />,
  )
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("SharePanel — member scopes wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lastMembersPanelProps = null
    mockMembers = leadMembers
    mockFetchProjectSettings.mockResolvedValue({
      version: 3,
      updatedAt: "2026-07-01T00:00:00Z",
      updatedBy: null,
      settings: { targetLanguage: "fr", targetLanes: ["es", "de"] },
    })
    mockResolveCloudProjectResult.mockResolvedValue({
      ok: true,
      project: {
        id: "proj-1",
        files: [
          { id: "f1", name: "Genesis" },
          { id: "f2", name: "Exodus" },
        ],
      },
    })
    mockFetchMemberScopes.mockResolvedValue([])
  })

  it("passes scopeConfig to MembersPanel when callerMaxRole >= 500 (project_lead)", async () => {
    renderPanel()

    await waitFor(() => {
      expect(lastMembersPanelProps?.scopeConfig).toBeDefined()
    })

    const config = lastMembersPanelProps!.scopeConfig!
    expect(config.lanes).toEqual([
      { value: "", label: "fr" },
      { value: "es", label: "es" },
      { value: "de", label: "de" },
    ])
    expect(config.files).toEqual([
      { id: "f1", name: "Genesis" },
      { id: "f2", name: "Exodus" },
    ])
    expect(typeof config.onSave).toBe("function")
  })

  it("does not pass scopeConfig when callerMaxRole < 500", async () => {
    mockMembers = contributorMembers
    renderPanel()

    // Give any stray effects a tick to (not) fire.
    await waitFor(() => {
      expect(lastMembersPanelProps).not.toBeNull()
    })

    expect(lastMembersPanelProps?.scopeConfig).toBeUndefined()
    expect(mockFetchProjectSettings).not.toHaveBeenCalled()
    expect(mockResolveCloudProjectResult).not.toHaveBeenCalled()
    expect(mockFetchMemberScopes).not.toHaveBeenCalled()
  })

  it("fetches scopes for scopable (sub-500) members and feeds scopesByUser", async () => {
    mockFetchMemberScopes.mockImplementation(async (_jwt: string, _projectId: string, userId: number) =>
      userId === 2 ? [{ kind: "lane", value: "es" }] : [],
    )
    renderPanel()

    await waitFor(() => {
      expect(mockFetchMemberScopes).toHaveBeenCalledWith("test-jwt", "proj-1", 2)
    })
    // alice (userId 1) is project_lead (500) — never fetched/scoped.
    expect(mockFetchMemberScopes).not.toHaveBeenCalledWith("test-jwt", "proj-1", 1)

    await waitFor(() => {
      expect(lastMembersPanelProps?.scopeConfig?.scopesByUser[2]).toEqual([
        { kind: "lane", value: "es" },
      ])
    })
  })

  it("onSave calls putMemberScopes and updates scopesByUser", async () => {
    mockPutMemberScopes.mockResolvedValue([{ kind: "file", value: "f1" }])
    renderPanel()

    await waitFor(() => {
      expect(lastMembersPanelProps?.scopeConfig).toBeDefined()
    })

    await lastMembersPanelProps!.scopeConfig!.onSave(2, [{ kind: "file", value: "f1" }])

    expect(mockPutMemberScopes).toHaveBeenCalledWith(
      "test-jwt", "proj-1", 2, [{ kind: "file", value: "f1" }],
    )
    await waitFor(() => {
      expect(lastMembersPanelProps?.scopeConfig?.scopesByUser[2]).toEqual([
        { kind: "file", value: "f1" },
      ])
    })
  })

  it("falls back to lanes: [{value:'', label:'Default'}] when settings aren't loaded yet", async () => {
    mockFetchProjectSettings.mockResolvedValue(null)
    renderPanel()

    await waitFor(() => {
      expect(lastMembersPanelProps?.scopeConfig).toBeDefined()
    })
    expect(lastMembersPanelProps!.scopeConfig!.lanes).toEqual([
      { value: "", label: "Default" },
    ])
  })
})

// AQU-625: the caller's authoritative project role (project.syncRole, threaded
// as canManageMembers) decides whether the Members-tab add/search field is
// usable. This must not depend on the roster (which is hidden for the exact
// low-role callers we're protecting against).
describe("SharePanel — add-member gate wiring (AQU-625)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lastMembersPanelProps = null
    mockMembers = leadMembers
    mockFetchProjectSettings.mockResolvedValue({
      version: 3,
      updatedAt: "2026-07-01T00:00:00Z",
      updatedBy: null,
      settings: { targetLanguage: "fr", targetLanes: ["es", "de"] },
    })
    mockResolveCloudProjectResult.mockResolvedValue({ ok: true, project: { id: "proj-1", files: [] } })
    mockFetchMemberScopes.mockResolvedValue([])
  })

  it("passes canAddMembers=false to MembersPanel when the caller can't manage members", async () => {
    renderPanel("proj-1", false)
    await waitFor(() => expect(lastMembersPanelProps).not.toBeNull())
    expect(lastMembersPanelProps?.canAddMembers).toBe(false)
  })

  it("passes canAddMembers=true when the caller can manage members", async () => {
    renderPanel("proj-1", true)
    await waitFor(() => expect(lastMembersPanelProps).not.toBeNull())
    expect(lastMembersPanelProps?.canAddMembers).toBe(true)
  })

  it("falls back to the roster-derived caller role when canManageMembers is omitted", async () => {
    // alice (the mocked caller) is a contributor (400) < project_lead in this roster.
    mockMembers = contributorMembers
    renderPanel("proj-1")
    await waitFor(() => expect(lastMembersPanelProps).not.toBeNull())
    expect(lastMembersPanelProps?.canAddMembers).toBe(false)
  })
})
