/**
 * "Suggest from edits" mines the cells this pane loads, so the pane must load
 * them in the lane it is viewing and tell the surface when that corpus is not
 * ready. Reading the default lane while the user translates into a named lane,
 * or mining before the read lands, both end in "No edit patterns found".
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render } from "@testing-library/react"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { username: "tester", jwt: "session-jwt" }, loading: false }),
}))
vi.mock("@/context/OrgContext", () => ({
  useActiveOrgOptional: () => null,
}))
vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({
    project: { id: "p1", name: "P", files: [] } as unknown as ProjectRecord,
    loading: false,
    refresh: vi.fn(),
    patchSettings: vi.fn(),
    roleLevel: 700,
  }),
}))
const useProjectCells = vi.fn()
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: (opts: unknown) => useProjectCells(opts),
}))
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({
    orgRules: [],
    promotionRequests: [],
    canEdit: false,
    canRequestPromotion: false,
    requestPromotion: vi.fn(),
    patch: vi.fn(),
    version: 0,
  }),
}))
vi.mock("@/hooks/useRules", () => ({
  useRules: () => ({
    rules: [],
    userRules: [],
    builtinRules: [],
    addRule: vi.fn(),
    updateRule: vi.fn(),
    deleteRule: vi.fn(),
    setBuiltinOverride: vi.fn(),
  }),
}))
// The surface itself is not under test; a marker keeps the assertion about the
// notice, not about the rules list's internals.
const surfaceProps = vi.fn()
vi.mock("@/components/RulesSurface", () => ({
  RulesSurface: (props: unknown) => {
    surfaceProps(props)
    return <div data-testid="rules-surface" />
  },
}))
vi.mock("@/lib/sync/cqrs-bridge", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync/cqrs-bridge")>()),
  buildFileScopedTokenFetcher: () => async () => "file-token",
}))
vi.mock("@/lib/sync/outbox-flush", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync/outbox-flush")>()),
  subscribeAppliedEvents: () => () => {},
}))

vi.mock("@/hooks/useConcepts", () => ({
  useConcepts: () => ({ concepts: [], error: undefined }),
}))

import { RulesSettingsSection } from "./RulesSection"

beforeEach(() => {
  useProjectCells.mockReset()
  surfaceProps.mockReset()
})

describe("RulesSettingsSection — corpus for Suggest from edits", () => {
  it("reads the corpus in the viewed lane", () => {
    useProjectCells.mockReturnValue({ files: [], isLoading: false })
    render(<RulesSettingsSection projectId="p1" activeLane="grc" />)
    expect(useProjectCells).toHaveBeenCalledWith(expect.objectContaining({ lane: "grc" }))
  })

  it("passes the loading state and read error to the surface", () => {
    const error = new Error("boom")
    useProjectCells.mockReturnValue({ files: [], isLoading: true, error })
    render(<RulesSettingsSection projectId="p1" />)
    expect(surfaceProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ cellsLoading: true, cellsError: error }),
    )
  })
})
