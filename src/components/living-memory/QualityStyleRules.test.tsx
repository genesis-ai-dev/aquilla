/**
 * QualityStyleRules — style-rule library section on the Translation quality
 * pane (AQU-934 phase 2).
 *
 * The hook, the knowledge client and the extractor are all mocked: this suite
 * is about the section's wiring (which mutation each affordance calls, with
 * what payload) and its role gates, not about network behaviour.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ROLE } from "@/lib/frontier/roles"
import type { KnowledgeDocument } from "@/lib/frontier/knowledge-base"
import type { RuleApplicability, StyleRule } from "@/lib/rules/style-rule-types"
import type { CompletionSettings } from "@/lib/parsers/types"
import { QualityStyleRules } from "./QualityStyleRules"

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

async function renderSection(roleLevel: number | null = ROLE.PROJECT_LEAD) {
  const result = render(
    <QualityStyleRules
      projectId="proj-1"
      roleLevel={roleLevel}
      completionSettings={SETTINGS}
      session={{ jwt: "tok", username: "alice", createdAt: "2026-01-01T00:00:00.000Z" }}
    />,
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

describe("QualityStyleRules — candidates queue", () => {
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

// ── Library ────────────────────────────────────────────────────────────────

describe("QualityStyleRules — approved library", () => {
  const approved = [
    makeRule({ id: "r-term", status: "approved", category: "terminology", instruction: "Render 'covenant' consistently" }),
    makeRule({ id: "r-style", status: "approved", category: "style", instruction: "Keep sentences short", scope: "genre" }),
  ]

  it("groups rules by category and skips empty groups", async () => {
    mockHook({ rules: approved })
    await renderSection()

    expect(screen.getByText("Terminology rules")).toBeInTheDocument()
    expect(screen.getByText("General style rules")).toBeInTheDocument()
    expect(screen.queryByText("Grammar rules")).not.toBeInTheDocument()
    expect(screen.queryByText("Formatting rules")).not.toBeInTheDocument()
    expect(screen.getByText("Render 'covenant' consistently")).toBeInTheDocument()
    expect(screen.getByText("Keep sentences short")).toBeInTheDocument()
  })

  it("toggles enabled through updateRule", async () => {
    mockHook({ rules: [approved[0]] })
    await renderSection()

    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }))
    await waitFor(() => expect(updateRule).toHaveBeenCalledWith("r-term", { enabled: false }))
  })

  it("disables the enabled toggle and applicability button below PROJECT_LEAD", async () => {
    mockHook({ rules: [approved[0]] })
    await renderSection(ROLE.CONTRIBUTOR)

    // Base UI's Switch renders a span with role=switch, so the disabled state
    // lands on aria-disabled rather than the `disabled` attribute.
    expect(screen.getByRole("switch", { name: "Enabled" })).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    expect(screen.getByRole("button", { name: "Where it applies" })).toBeDisabled()
  })
})

// ── Applicability dialog ───────────────────────────────────────────────────

describe("QualityStyleRules — applicability dialog", () => {
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

describe("QualityStyleRules — extraction", () => {
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

describe("QualityStyleRules — gates and empty states", () => {
  it("shows both empty states with no rules at all", async () => {
    await renderSection()
    expect(screen.getByText("Nothing is waiting for review.")).toBeInTheDocument()
    expect(screen.getByText(/No approved style rules yet/)).toBeInTheDocument()
  })

  it("hides the extract action below CONTRIBUTOR and shows the role lock", async () => {
    await renderSection(ROLE.REVIEWER)
    expect(
      screen.queryByRole("button", { name: /Extract from knowledge base/ }),
    ).not.toBeInTheDocument()
    // The lock must name the floor it actually gates on (Contributor for
    // extraction), not the maintainer floor the entry sections use.
    expect(screen.getAllByLabelText(/requires Contributor role/i).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText(/requires Maintainer role/i)).not.toBeInTheDocument()
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
