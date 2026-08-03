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

interface CapturedMembersPanelProps {
  scopeConfig?: MembersPanelScopeConfig
  suggestions?: Array<{ id: number; username: string }>
  emptySuggestionsHint?: string
}

let lastMembersPanelProps: CapturedMembersPanelProps | null = null

vi.mock("./MembersPanel", () => ({
  MembersPanel: (props: CapturedMembersPanelProps) => {
    lastMembersPanelProps = props
    return null
  },
}))

// Org context + roster driving the eligible-colleague suggestions (AQU-672
// parity in the Share modal). Defaults to "no org" so the pre-existing suites
// keep their original conditions.
const orgMocks = vi.hoisted(() => ({
  activeOrgId: null as number | null,
  roster: [] as Array<{ userId: number; username: string; role: { level: number; name: string } }>,
}))

vi.mock("@/context/OrgContext", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/context/OrgContext")>()
  return {
    ...original,
    useActiveOrgOptional: () =>
      orgMocks.activeOrgId == null ? null : { activeOrgId: orgMocks.activeOrgId },
  }
})

vi.mock("@/lib/frontier/orgs", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/frontier/orgs")>()
  return {
    ...original,
    listOrgMembers: vi.fn(async () => orgMocks.roster),
  }
})

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
    addMany: vi.fn(async () => []),
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

function renderPanel(projectId = "proj-1") {
  return render(
    <SharePanel open={true} onOpenChange={() => {}} projectId={projectId} />,
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
    expect(mockFetchMemberScopes).not.toHaveBeenCalled()
    // resolveCloudProjectResult is NOT asserted quiet here: it also serves
    // useProjectOrgId (org-member suggestions), which runs for every caller.
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

// AQU-672 parity in the Share modal: the Members tab offers org colleagues as
// checkbox suggestions before any search. Eligibility = org roster minus
// project-level grants (direct/team/creator); org-access-only members stay
// eligible so they can be given an explicit project role.
describe("SharePanel — eligible org-member suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lastMembersPanelProps = null
    mockMembers = leadMembers
    orgMocks.activeOrgId = 7
    orgMocks.roster = []
    mockFetchProjectSettings.mockResolvedValue(null)
    mockResolveCloudProjectResult.mockResolvedValue({ ok: false })
    mockFetchMemberScopes.mockResolvedValue([])
  })

  it("passes org members without a project grant as suggestions", async () => {
    // alice(1) + bob(2) hold direct grants; dana(5) is org-only → eligible.
    orgMocks.roster = [
      { userId: 1, username: "alice", role: { level: 600, name: "maintainer" } },
      { userId: 2, username: "bob", role: { level: 400, name: "contributor" } },
      { userId: 5, username: "dana", role: { level: 400, name: "contributor" } },
    ]
    renderPanel()

    await waitFor(() => {
      expect(lastMembersPanelProps?.suggestions).toEqual([{ id: 5, username: "dana" }])
    })
    expect(lastMembersPanelProps?.emptySuggestionsHint).toMatch(/already have access/i)
  })

  it("passes no suggestions without org context (personal project)", async () => {
    orgMocks.activeOrgId = null
    renderPanel()

    await waitFor(() => {
      expect(lastMembersPanelProps).not.toBeNull()
    })
    expect(lastMembersPanelProps?.suggestions).toBeUndefined()
  })

  it("prefers the project's own org over the active-org picker", async () => {
    // Picker is on org 7 but the project belongs to org 9 — the roster must
    // come from 9 (the picker may even be on \"All organizations\").
    mockResolveCloudProjectResult.mockResolvedValue({
      ok: true,
      project: { id: "proj-1", name: "P", orgId: 9 },
    })
    orgMocks.roster = [
      { userId: 5, username: "dana", role: { level: 400, name: "contributor" } },
    ]
    renderPanel()

    await waitFor(() => {
      expect(lastMembersPanelProps?.suggestions).toEqual([{ id: 5, username: "dana" }])
    })
    const { listOrgMembers } = await import("@/lib/frontier/orgs")
    expect(vi.mocked(listOrgMembers)).toHaveBeenCalledWith("test-jwt", 9)
  })
})
