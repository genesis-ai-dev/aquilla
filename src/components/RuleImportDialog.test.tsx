/**
 * RuleImportDialog — AQU-196 acceptance-criteria regression guard.
 *
 * The two-pass document import shipped without any component-level coverage,
 * so three of its acceptance criteria were only ever verified by reading the
 * code: the size-cap rejection ("no extraction call is made"), the running
 * progress readout ("not just a spinner"), and the LLM usage entry recorded
 * for *every* call across both passes.
 *
 * These tests pin those criteria at the level they'd regress — the dialog,
 * where the extractor, the progress state, and the usage writer are wired
 * together. `rule-extractor.test.ts` covers the pure parse/size helpers; the
 * composition of extractor → dialog is what escaped.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { RuleImportDialog } from "./RuleImportDialog"
import { MAX_INPUT_BYTES } from "@/lib/rules/rule-extractor"
import type { CompletionSettings, ProjectRecord } from "@/lib/parsers/types"

// ── LLM ──────────────────────────────────────────────────────────────────────
// Routed by system prompt so the two passes stay distinguishable no matter
// what order the dialog calls them in.
const completeCalls: string[] = []
let pass1Response = "[]"
/** Resolvers for the pass-2 calls, so a test can hold extraction mid-flight. */
let pass2Queue: Array<(value: string) => void> = []
let pass2Auto: string | null = null

vi.mock("@/lib/completion/completion-service", () => ({
  DEFAULT_SYSTEM_PROMPT: "test-system-prompt",
  complete: (args: { messages: Array<{ role: string; content: string }> }) => {
    const system = args.messages[0]?.content ?? ""
    const pass = system.includes("Extract every rule") ? "pass1" : "pass2"
    completeCalls.push(pass)
    if (pass === "pass1") return Promise.resolve(pass1Response)
    if (pass2Auto !== null) return Promise.resolve(pass2Auto)
    return new Promise<string>((resolve) => pass2Queue.push(resolve))
  },
}))

// ── Session / health — the trigger is disabled until the LLM is configured ───
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt-1", username: "dev" } }),
}))
vi.mock("@/lib/completion/frontier-health", () => ({
  useFrontierHealth: () => ({ available: true }),
}))

// ── Project store — where the usage entry lands ──────────────────────────────
let storedProject: ProjectRecord
vi.mock("@/lib/store/project-index", () => ({
  getProject: () => Promise.resolve(storedProject),
  updateProject: (p: ProjectRecord) => {
    storedProject = p
    return Promise.resolve()
  },
}))

const SETTINGS: CompletionSettings = {
  provider: "custom",
  endpoint: "https://llm.example/v1",
  model: "test-model",
  maxTokens: 2048,
  temperature: 0.1,
  systemPrompt: "sys",
  llmHealthPenalty: 0.1,
}

function structuredRule(name: string) {
  return JSON.stringify({
    name,
    description: `Why ${name} matters`,
    severity: "minor",
    check: { type: "target-forbids", targetPattern: "foo" },
  })
}

function renderDialog(onAdd = vi.fn()) {
  render(
    <RuleImportDialog completionSettings={SETTINGS} onAdd={onAdd} projectId="p1" />,
  )
  return onAdd
}

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /import from doc/i }))
  return screen.findByPlaceholderText(/paste text here/i)
}

/** Paste text into the dialog's paste zone the way a user would. */
function pasteInto(el: HTMLElement, text: string) {
  fireEvent.paste(el, { clipboardData: { getData: () => text } })
}

beforeEach(() => {
  completeCalls.length = 0
  pass1Response = "[]"
  pass2Queue = []
  pass2Auto = null
  storedProject = {
    id: "p1",
    name: "Test project",
  } as ProjectRecord
})

describe("RuleImportDialog — AQU-196", () => {
  it("rejects over-cap paste with a clear message and makes no extraction call", async () => {
    renderDialog()
    const paste = await openDialog()

    pasteInto(paste, "a".repeat(MAX_INPUT_BYTES + 1))

    expect(await screen.findByText(/too large/i)).toBeInTheDocument()
    // The whole point of the cap: the document never reaches the LLM.
    expect(completeCalls).toEqual([])
  })

  it("rejects an over-cap dropped text file before reading it", async () => {
    renderDialog()
    await openDialog()

    const file = new File(["a".repeat(MAX_INPUT_BYTES + 1)], "style-guide.txt", {
      type: "text/plain",
    })
    // The drop-zone cap and the extractor cap are one limit; a file that clears
    // the former but not the latter would reach the LLM.
    expect(file.size).toBeGreaterThan(MAX_INPUT_BYTES)
    const dropZone = screen
      .getByRole("button", { name: /browse file/i })
      .closest("div") as HTMLElement
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } })

    expect(await screen.findByText(/file too large/i)).toBeInTheDocument()
    expect(completeCalls).toEqual([])
  })

  it("shows running progress across pass 2 rather than a bare spinner", async () => {
    renderDialog()
    const paste = await openDialog()

    pass1Response = JSON.stringify(["Rule one", "Rule two"])
    pasteInto(paste, "always capitalize divine pronouns")

    // Pass 1 in flight / just finished: the dialog announces the phase.
    expect(await screen.findByText(/extracting rules from document/i)).toBeInTheDocument()

    // Pass 2 structures candidates one at a time; the count must advance as
    // each lands, so the user sees movement on a long document.
    await waitFor(() => expect(pass2Queue).toHaveLength(1))
    pass2Queue[0](structuredRule("Rule one"))

    expect(await screen.findByText(/1 of 2 candidates processed/i)).toBeInTheDocument()

    // The final candidate ends the progress readout by handing off to review,
    // so the count is observable while work remains, not after it finishes.
    await waitFor(() => expect(pass2Queue).toHaveLength(2))
    pass2Queue[1](structuredRule("Rule two"))

    expect(await screen.findByText(/review 2 extracted rules/i)).toBeInTheDocument()
  })

  it("records an LLM usage entry for every call in both passes", async () => {
    renderDialog()
    const paste = await openDialog()

    pass1Response = JSON.stringify(["Rule one", "Rule two"])
    pass2Auto = structuredRule("Rule one")
    pasteInto(paste, "always capitalize divine pronouns")

    // Review screen means both passes completed.
    expect(await screen.findByText(/review 2 extracted rules/i)).toBeInTheDocument()

    await waitFor(() => {
      expect(storedProject.usage?.llmCalls["rule-extract-pass1"]?.total).toBe(1)
      // One structuring call per candidate — an under-count here means the
      // read-modify-write cycles raced and dropped entries.
      expect(storedProject.usage?.llmCalls["rule-extract-pass2"]?.total).toBe(2)
    })
  })

  it("turns pasted prose into reviewable drafts that commit as user rules", async () => {
    const onAdd = renderDialog()
    const paste = await openDialog()

    pass1Response = JSON.stringify(["Rule one"])
    pass2Auto = structuredRule("No ellipsis")
    pasteInto(paste, "never end a sentence with an ellipsis")

    expect(await screen.findByText(/review 1 extracted rule/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /add 1 rule/i }))

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1))
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "No ellipsis",
        severity: "minor",
        source: "llm",
        scope: "project",
        enabled: true,
        check: { type: "target-forbids", targetPattern: "foo" },
      }),
    )
  })
})
