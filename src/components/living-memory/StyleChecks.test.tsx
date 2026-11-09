/**
 * StyleChecks — the style-rule store behind the unified Checks list
 * (AQU-934 phase 2; AQU-2342). Approved rules are rendered here through the
 * same StyleCheckRow the Checks list uses, so the wiring is tested end to end.
 *
 * The hook, the knowledge client and the extractor are all mocked: this suite
 * is about the section's wiring (which mutation each affordance calls, with
 * what payload) and its role gates, not about network behaviour.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ROLE } from "@/lib/frontier/roles"
import type { KnowledgeDocument } from "@/lib/frontier/knowledge-base"
import type { RuleApplicability, StyleRule } from "@/lib/rules/style-rule-types"
import type { CompletionSettings } from "@/lib/parsers/types"
import { StyleChecks, type StyleChecksBinding } from "./StyleChecks"
import { StyleCheckRow } from "@/components/checks/OtherCheckRows"

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/hooks/useStyleRules", () => ({ useStyleRules: vi.fn() }))
vi.mock("@/lib/frontier/knowledge-base", () => ({
  listKnowledgeDocuments: vi.fn(),
  getKnowledgeDocument: vi.fn(),
}))
vi.mock("@/lib/rules/style-rule-extractor", () => ({
  extractStyleRulesFromDoc: vi.fn(),
  flattenLeafNodes: vi.fn(),
}))

import { useStyleRules } from "@/hooks/useStyleRules"
import { getKnowledgeDocument, listKnowledgeDocuments } from "@/lib/frontier/knowledge-base"
import { extractStyleRulesFromDoc, flattenLeafNodes } from "@/lib/rules/style-rule-extractor"

const refresh = vi.fn(async () => {})
const createRule = vi.fn(async () => null as StyleRule | null)
const updateRule = vi.fn(async () => null as StyleRule | null)
const review = vi.fn(async () => null as StyleRule | null)
const setApplicability = vi.fn(async () => null as RuleApplicability | null)
const removeApplicability = vi.fn(async () => true)

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id: "rule-1",
    orgId: null,
    projectId: "proj-1",
    instruction: "Use formal register",
    category: "register",
    scope: "global",
    conditions: null,
    examples: null,
    exceptions: null,
    source: null,
    checkSpec: null,
    severity: "minor",
    enabled: true,
    status: "proposed",
    humanEdited: false,
    provenance: null,
    createdBy: "alice",
    reviewedBy: null,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function makeRow(overrides: Partial<RuleApplicability> = {}): RuleApplicability {
  return {
    id: "app-1",
    ruleId: "rule-1",
    targetType: "book",
    targetId: "PSA",
    relationship: "applies",
    confidence: null,
    reason: null,
    assignedBy: "model",
    createdBy: "alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function makeDoc(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: "doc-1",
    orgId: null,
    projectId: "proj-1",
    scope: "project",
    name: "Style Guide",
    contentType: "text/plain",
    sizeBytes: 10,
    sha256: "abc",
    r2Key: "k",
    docSummary: null,
    indexStatus: "ready",
    indexError: null,
    nodeCount: 3,
    createdBy: "alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

const SETTINGS = { endpoint: "", model: "", maxTokens: 512, temperature: 0.2, systemPrompt: "" } as CompletionSettings

function mockHook(overrides: { rules?: StyleRule[]; applicability?: RuleApplicability[]; error?: string | null } = {}) {
  vi.mocked(useStyleRules).mockReturnValue({
    rules: overrides.rules ?? [],
    applicability: overrides.applicability ?? [],
    loading: false,
    error: overrides.error ?? null,
    refresh,
    createRule,
    updateRule,
    review,
    setApplicability,
    removeApplicability,
  })
}

/** The parts of the Checks list a style binding feeds: its rows, the review
 *  queue, the error banner, and the Add-check "extract" choice. */
function Harness({ binding }: { binding: StyleChecksBinding }) {
  return (
    <>
      {binding.errorBanner}
      {binding.extract ? (
        <button type="button" onClick={binding.extract}>Extract from knowledge base</button>
      ) : null}
      <ul>
        {binding.rules
          .filter((rule) => rule.status === "approved")
          .map((rule) => (
            <StyleCheckRow
              key={rule.id}
              rule={rule}
              chips={null}
              categoryLabel={binding.labels.category[rule.category]}
              canManage={binding.canManage}
              onToggle={(enabled) => binding.toggle(rule, enabled)}
              onOpenApplicability={() => binding.openApplicability(rule)}
            />
          ))}
      </ul>
      {binding.reviewQueue}
    </>
  )
}

async function renderSection(roleLevel: number | null = ROLE.PROJECT_LEAD) {
  const result = render(
    <StyleChecks
      projectId="proj-1"
      roleLevel={roleLevel}
      completionSettings={SETTINGS}
      session={{ jwt: "tok", username: "alice", createdAt: "2026-01-01T00:00:00.000Z" }}
    >
      {(binding) => <Harness binding={binding} />}
    </StyleChecks>,
  )
  // Settles the knowledge-document fetch the section fires on mount.
  await waitFor(() => expect(vi.mocked(listKnowledgeDocuments)).toHaveBeenCalled())
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
  mockHook()
  vi.mocked(listKnowledgeDocuments).mockResolvedValue([])
  vi.mocked(flattenLeafNodes).mockImplementation((tree) => tree)
  vi.mocked(extractStyleRulesFromDoc).mockResolvedValue([])
  createRule.mockResolvedValue(makeRule())
})

// ── Candidates queue ───────────────────────────────────────────────────────

describe("StyleChecks — candidates queue", () => {
  beforeEach(() => {
    vi.mocked(listKnowledgeDocuments).mockResolvedValue([makeDoc()])
    mockHook({
      rules: [
        makeRule({
          source: { kind: "knowledge-doc", docId: "doc-1", nodeId: "n1", quote: "Keep the tone formal." },
        }),
      ],
    })
  })

  it("renders the instruction, its category and scope chips, and the source citation", async () => {
    await renderSection()
    expect(screen.getByText("Use formal register")).toBeInTheDocument()
    expect(screen.getByText("Register rules")).toBeInTheDocument()
    expect(screen.getByText("Project-wide")).toBeInTheDocument()
    expect(await screen.findByText("Extracted from Style Guide")).toBeInTheDocument()
    expect(screen.getByText("Keep the tone formal.")).toBeInTheDocument()
  })

  it("approves and rejects through review()", async () => {
    await renderSection()
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    expect(review).toHaveBeenCalledWith("rule-1", "approve")

    fireEvent.click(screen.getByRole("button", { name: "Reject" }))
    expect(review).toHaveBeenCalledWith("rule-1", "reject")
  })

  it("edits through updateRule without approving the rule", async () => {
    await renderSection()
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))

    const instruction = await screen.findByLabelText("Instruction")
    fireEvent.change(instruction, { target: { value: "Use formal register throughout" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(updateRule).toHaveBeenCalledWith("rule-1", {
      instruction: "Use formal register throughout",
      category: "register",
      severity: "minor",
      conditions: null,
    })
    expect(review).not.toHaveBeenCalled()
  })

  it("shows the pending count badge", async () => {
    await renderSection()
    expect(screen.getByText("1 awaiting review")).toBeInTheDocument()
  })
})

// ── Batched review (AQU-2366) ──────────────────────────────────────────────

describe("StyleChecks — batched proposal review", () => {
  /** `count` proposals, instructions numbered so a batch boundary is visible. */
  function proposals(count: number): StyleRule[] {
    return Array.from({ length: count }, (_, i) =>
      makeRule({ id: `cand-${i + 1}`, instruction: `Proposed rule ${i + 1}` }),
    )
  }

  it("shows one batch of ten and reveals the rest through Show more", async () => {
    mockHook({ rules: proposals(12) })
    await renderSection()

    expect(screen.getByText("Proposed rule 10")).toBeInTheDocument()
    expect(screen.queryByText("Proposed rule 11")).not.toBeInTheDocument()
    // The count badge still reports every pending proposal, batched or not.
    expect(screen.getByText("12 awaiting review")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }))

    expect(screen.getByText("Proposed rule 11")).toBeInTheDocument()
    expect(screen.getByText("Proposed rule 12")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).not.toBeInTheDocument()
  })

  it("leaves the approved library unaffected by the number of proposals", async () => {
    mockHook({
      rules: [
        ...proposals(12),
        makeRule({ id: "r-approved", status: "approved", instruction: "Keep sentences short" }),
      ],
    })
    await renderSection()

    // AQU-2366 acceptance: approved rows are the library, proposals are not.
    expect(screen.getByText("Keep sentences short")).toBeInTheDocument()
    expect(screen.getAllByRole("switch")).toHaveLength(1)
  })

  it("dismisses everything past the visible batch in one action, and can undo it", async () => {
    mockHook({ rules: proposals(12) })
    await renderSection()
    // Installed after mount on purpose: RTL's `waitFor` does not recognise
    // vitest's fake timers, so faking them around `render` would stall it.
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss the remaining 2" }))

      // Staged, not sent: the queue drops them and offers the undo.
      expect(screen.queryByText("Proposed rule 11")).not.toBeInTheDocument()
      expect(screen.getByText("2 proposed rules dismissed")).toBeInTheDocument()
      expect(review).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole("button", { name: "Undo" }))
      act(() => { vi.advanceTimersByTime(60_000) })

      expect(screen.queryByText("2 proposed rules dismissed")).not.toBeInTheDocument()
      expect(review).not.toHaveBeenCalled()
      expect(screen.getByRole("button", { name: "Dismiss the remaining 2" })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects the dismissed proposals once the undo window closes", async () => {
    mockHook({ rules: proposals(12) })
    await renderSection()
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss the remaining 2" }))
      // Awaited: the parent walks the ids one verdict at a time.
      await act(async () => { vi.advanceTimersByTime(8_000) })

      expect(review).toHaveBeenCalledTimes(2)
      expect(review).toHaveBeenCalledWith("cand-11", "reject")
      expect(review).toHaveBeenCalledWith("cand-12", "reject")
    } finally {
      vi.useRealTimers()
    }
  })

  it("offers no bulk dismissal below Project Lead", async () => {
    mockHook({ rules: proposals(12) })
    await renderSection(ROLE.CONTRIBUTOR)

    expect(screen.getByRole("button", { name: "Show 2 more" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Dismiss the remaining/ })).not.toBeInTheDocument()
  })
})

// ── Library ────────────────────────────────────────────────────────────────

describe("StyleChecks — approved library", () => {
  const approved = [
    makeRule({ id: "r-term", status: "approved", category: "terminology", instruction: "Render 'covenant' consistently" }),
    makeRule({ id: "r-style", status: "approved", category: "style", instruction: "Keep sentences short", scope: "genre" }),
  ]

  it("labels each approved rule with its category", async () => {
    mockHook({ rules: approved })
    await renderSection()

    expect(screen.getByText("Terminology rules")).toBeInTheDocument()
    expect(screen.getByText("General style rules")).toBeInTheDocument()
    expect(screen.getByText("Render 'covenant' consistently")).toBeInTheDocument()
    expect(screen.getByText("Keep sentences short")).toBeInTheDocument()
  })

  it("toggles enabled through updateRule", async () => {
    mockHook({ rules: [approved[0]] })
    await renderSection()

    fireEvent.click(screen.getByRole("switch", { name: /Disable/ }))
    await waitFor(() => expect(updateRule).toHaveBeenCalledWith("r-term", { enabled: false }))
  })

  it("disables the enabled toggle and applicability button below PROJECT_LEAD", async () => {
    mockHook({ rules: [approved[0]] })
    await renderSection(ROLE.CONTRIBUTOR)

    // Base UI's Switch renders a span with role=switch, so the disabled state
    // lands on aria-disabled rather than the `disabled` attribute.
    expect(screen.getByRole("switch", { name: /Disable/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    expect(screen.getByRole("button", { name: "Where it applies" })).toBeDisabled()
  })
})

// ── Applicability dialog ───────────────────────────────────────────────────

describe("StyleChecks — applicability dialog", () => {
  beforeEach(() => {
    mockHook({
      rules: [makeRule({ status: "approved", category: "terminology" })],
      applicability: [makeRow()],
    })
  })

  it("lists the rule's existing rows", async () => {
    await renderSection()
    fireEvent.click(screen.getByRole("button", { name: "Where it applies" }))

    expect(await screen.findByText("Where this rule applies")).toBeInTheDocument()
    expect(screen.getByText("PSA")).toBeInTheDocument()
    expect(screen.getByText("Suggested by AI")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Remove this target" })).toBeInTheDocument()
  })

  it("adds a row as a human assignment", async () => {
    await renderSection()
    fireEvent.click(screen.getByRole("button", { name: "Where it applies" }))

    const target = await screen.findByLabelText("Target value")
    fireEvent.change(target, { target: { value: "LUK" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    expect(setApplicability).toHaveBeenCalledWith("rule-1", {
      targetType: "book",
      targetId: "LUK",
      relationship: "applies",
      assignedBy: "human",
    })
  })

  it("removes a row through removeApplicability", async () => {
    await renderSection()
    fireEvent.click(screen.getByRole("button", { name: "Where it applies" }))

    fireEvent.click(await screen.findByRole("button", { name: "Remove this target" }))
    expect(removeApplicability).toHaveBeenCalledWith("rule-1", "app-1")
  })
})

// ── Extraction ─────────────────────────────────────────────────────────────

describe("StyleChecks — extraction", () => {
  beforeEach(() => {
    vi.mocked(listKnowledgeDocuments).mockResolvedValue([makeDoc()])
    vi.mocked(getKnowledgeDocument).mockResolvedValue({
      doc: makeDoc(),
      tree: [{ id: "n1", title: "Intro", charStart: 0, charEnd: 10 }],
    })
    vi.mocked(extractStyleRulesFromDoc).mockResolvedValue([
      {
        candidate: { instruction: "Render 'covenant' consistently", category: "terminology", scopeHint: "global" },
        nodeId: "n1",
        nodeTitle: "Intro",
        quote: "Terms must be stable.",
      },
      {
        candidate: { instruction: "Keep Psalms line breaks", category: "formatting", scopeHint: "book:PSA" },
        nodeId: "n2",
        nodeTitle: "Poetry",
        quote: "Poetry keeps its lines.",
      },
    ])
  })

  it("posts every survivor with its citation and its scope-hint applicability row", async () => {
    await renderSection()
    fireEvent.click(screen.getByRole("button", { name: /Extract from knowledge base/ }))

    fireEvent.click(await screen.findByRole("button", { name: "Start extraction" }))

    await waitFor(() => expect(createRule).toHaveBeenCalledTimes(2))
    expect(createRule).toHaveBeenNthCalledWith(1, {
      instruction: "Render 'covenant' consistently",
      category: "terminology",
      scope: "global",
      source: { kind: "knowledge-doc", docId: "doc-1", nodeId: "n1", quote: "Terms must be stable." },
    })
    expect(createRule).toHaveBeenNthCalledWith(2, {
      instruction: "Keep Psalms line breaks",
      category: "formatting",
      scope: "document",
      source: { kind: "knowledge-doc", docId: "doc-1", nodeId: "n2", quote: "Poetry keeps its lines." },
      applicability: [
        {
          targetType: "book",
          targetId: "PSA",
          relationship: "likely_applies",
          assignedBy: "model",
        },
      ],
    })
    expect(await screen.findByText("Added 2 proposed rules.")).toBeInTheDocument()
  })

  it("refreshes the queue when the dialog closes", async () => {
    await renderSection()
    fireEvent.click(screen.getByRole("button", { name: /Extract from knowledge base/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Start extraction" }))
    await waitFor(() => expect(createRule).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(refresh).toHaveBeenCalled()
  })

  it("reports a document that yields nothing", async () => {
    vi.mocked(extractStyleRulesFromDoc).mockResolvedValue([])
    await renderSection()
    fireEvent.click(screen.getByRole("button", { name: /Extract from knowledge base/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Start extraction" }))

    expect(await screen.findByText("That document produced no rules.")).toBeInTheDocument()
    expect(createRule).not.toHaveBeenCalled()
  })

  it("says so when there is no indexed knowledge document", async () => {
    vi.mocked(listKnowledgeDocuments).mockResolvedValue([makeDoc({ indexStatus: "pending" })])
    await renderSection()
    fireEvent.click(screen.getByRole("button", { name: /Extract from knowledge base/ }))

    expect(await screen.findByText(/No indexed knowledge documents yet/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Start extraction" })).toBeDisabled()
  })
})

// ── Gates and empty states ─────────────────────────────────────────────────

describe("StyleChecks — gates and empty states", () => {
  it("renders no review queue while nothing is proposed", async () => {
    await renderSection()
    expect(screen.queryByText("Proposed rules")).not.toBeInTheDocument()
  })

  it("offers no extract choice below CONTRIBUTOR", async () => {
    await renderSection(ROLE.REVIEWER)
    expect(
      screen.queryByRole("button", { name: /Extract from knowledge base/ }),
    ).not.toBeInTheDocument()
  })

  it("keeps the review actions disabled below PROJECT_LEAD", async () => {
    mockHook({ rules: [makeRule()] })
    await renderSection(ROLE.CONTRIBUTOR)

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled()
  })

  it("surfaces a load error", async () => {
    mockHook({ error: "network down" })
    await renderSection()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load the style-rule library: network down",
    )
  })
})
