/**
 * AQU-1340 — Settings → Rules must say when terminology rules could not be
 * loaded, instead of silently omitting them.
 *
 * Like the GlossaryEditor counterpart, the read is failed at its real producer
 * boundary (`fetchConcepts` rejecting with a `ConceptsReadError`) and the REAL
 * `useConcepts` runs, because the bug was the consumer discarding the `error`
 * the producer sets on purpose (AGENTS.md rules 12/13).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import type { Concept } from "@/lib/terminology/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ConceptsReadError } from "@/lib/sync/concepts-read"

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
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: () => ({ files: [], isLoading: false, isTruncated: false }),
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
vi.mock("@/components/RulesSurface", () => ({
  RulesSurface: () => <div data-testid="rules-surface" />,
}))
vi.mock("@/lib/sync/cqrs-bridge", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync/cqrs-bridge")>()),
  buildFileScopedTokenFetcher: () => async () => "file-token",
}))
vi.mock("@/lib/sync/outbox-flush", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync/outbox-flush")>()),
  subscribeAppliedEvents: () => () => {},
}))

const fetchConcepts = vi.fn<(projectId: string, jwt: string) => Promise<Concept[]>>()
vi.mock("@/lib/sync/concepts-read", async (orig) => {
  const actual = await orig<typeof import("@/lib/sync/concepts-read")>()
  return { ...actual, fetchConcepts: (p: string, j: string) => fetchConcepts(p, j) }
})

import { RulesSettingsSection } from "./RulesSection"

beforeEach(() => {
  fetchConcepts.mockReset()
})

describe("RulesSettingsSection — failed concepts read (AQU-1340)", () => {
  it("says terminology rules could not be loaded", async () => {
    fetchConcepts.mockRejectedValue(new ConceptsReadError(500, "concepts read failed"))
    render(<RulesSettingsSection projectId="p1" />)

    const notice = await screen.findByTestId("rules-terminology-unavailable")
    expect(notice).toHaveAttribute("role", "alert")
    expect(notice).toHaveTextContent(/Terminology rules could not be loaded/)
    // The rest of the list still renders — the notice is additive, not a gate.
    expect(screen.getByTestId("rules-surface")).toBeInTheDocument()
  })

  it("stays silent when the read succeeds", async () => {
    fetchConcepts.mockResolvedValue([])
    render(<RulesSettingsSection projectId="p1" />)

    await waitFor(() => expect(fetchConcepts).toHaveBeenCalled())
    expect(screen.queryByTestId("rules-terminology-unavailable")).not.toBeInTheDocument()
    expect(screen.getByTestId("rules-surface")).toBeInTheDocument()
  })
})
