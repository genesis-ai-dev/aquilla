/**
 * AQU-1721 — Settings → Rules must evaluate the same rule set the editor
 * enforces, and the editor applies the org termbases a project subscribes to.
 * So a subscribed termbase's term must produce infractions here too, and a
 * failed read of it must get the same notice as a failed read of the
 * project's own terminology.
 *
 * The REAL useRules and useSubscribedConcepts run. The read is answered at its
 * producer boundary: the subscriptions list and route #8 (AGENTS.md rule 12).
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import type { ProjectRecord, RuleInfraction } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { Concept } from "@/lib/terminology/types"
import type { TermbaseSubscription } from "@/lib/terminology/subscriptions-api"

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
// One translated cell whose source bears the subscribed term but whose target
// does not use its approved rendering.
const cell = {
  id: "cell-1",
  fileId: "f1",
  original: "the covenant endures",
  translated: "le pacte dure",
  status: "translated",
} as unknown as CellData
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: () => ({ files: [{ id: "f1", cells: [cell] }], isLoading: false }),
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
// The project's own termbase is empty, so any term infraction is subscribed.
vi.mock("@/hooks/useConcepts", () => ({
  useConcepts: () => ({ concepts: [], error: null }),
}))
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

const listSubscriptions = vi.fn<(jwt: string, projectId: string) => Promise<TermbaseSubscription[]>>()
vi.mock("@/lib/terminology/subscriptions-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/terminology/subscriptions-api")>()),
  listSubscriptions: (j: string, p: string) => listSubscriptions(j, p),
}))

import { RulesSettingsSection } from "./RulesSection"

const orgCovenant: Concept = {
  id: "org-covenant",
  sourceTerm: "covenant",
  renderings: [{ rendering: "alliance", status: "preferred" }],
  status: "active",
  createdAt: "2026-10-01T00:00:00Z",
}

/** Route #8 for the one subscribed termbase. */
function stubTermbase(concepts: Concept[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("/projects/tb-org/termbase/concepts?")) {
        throw new Error(`unexpected request: ${String(input)}`)
      }
      return new Response(JSON.stringify({ concepts }), { status: 200 })
    }),
  )
}

function lastInfractions(): Map<string, RuleInfraction[]> {
  const props = surfaceProps.mock.calls.at(-1)?.[0] as { infractions: Map<string, RuleInfraction[]> }
  return props.infractions
}

afterEach(() => {
  vi.unstubAllGlobals()
  listSubscriptions.mockReset()
  surfaceProps.mockReset()
})

describe("RulesSettingsSection — subscribed termbases (AQU-1721)", () => {
  it("evaluates a subscribed termbase's term like the editor does", async () => {
    listSubscriptions.mockResolvedValue([
      { termbaseProjectId: "tb-org", termbaseName: "Org terms", priority: 0, createdAt: "2026-10-01T00:00:00Z", published: true },
    ])
    stubTermbase([orgCovenant])

    render(<RulesSettingsSection projectId="p1" />)

    await waitFor(() =>
      expect(lastInfractions().get("cell-1")?.map((i) => i.ruleId)).toContain("term:org-covenant:approved"),
    )
    expect(screen.queryByTestId("rules-terminology-unavailable")).not.toBeInTheDocument()
  })

  it("says terminology rules could not be loaded when the subscribed read fails", async () => {
    listSubscriptions.mockRejectedValue(new Error("subscriptions list failed"))
    stubTermbase([])

    render(<RulesSettingsSection projectId="p1" />)

    const notice = await screen.findByTestId("rules-terminology-unavailable")
    expect(notice).toHaveTextContent(/Terminology rules could not be loaded/)
    expect(screen.getByTestId("rules-surface")).toBeInTheDocument()
  })
})
