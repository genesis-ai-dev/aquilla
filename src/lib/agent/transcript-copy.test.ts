/**
 * transcript-copy tests (AQU-1652) — the clipboard must carry what the reader
 * saw: labelled turns, attached source chips as their quoted wording, and no
 * machinery (wire tokens, the chip legend, `NEXT:` suggestion markers) that
 * only ever existed off screen.
 */

import { describe, expect, it } from "vitest"
import { serializeWithChips, buildSourceChip } from "./context-chip"
import type { AgentRunUi } from "./run-state"
import { assistantTurnText, formatTranscriptMarkdown, userTurnText } from "./transcript-copy"

const LABELS = { user: "You", assistant: "Coordinator" }

function makeRun(overrides: Partial<AgentRunUi> = {}): AgentRunUi {
  return {
    localId: "run-1",
    prompt: "Draft MRK 4:1",
    wireContent: "Draft MRK 4:1",
    runId: "r1",
    items: [],
    status: "ok",
    ...overrides,
  }
}

describe("formatTranscriptMarkdown", () => {
  it("labels every turn in order", () => {
    const text = formatTranscriptMarkdown(
      [
        makeRun({
          prompt: "Draft MRK 4:1",
          wireContent: "Draft MRK 4:1",
          items: [{ id: "t1", kind: "text", text: "Here is a draft." }],
        }),
        makeRun({
          localId: "run-2",
          prompt: "Now check it",
          wireContent: "Now check it",
          items: [{ id: "t2", kind: "text", text: "It reads naturally." }],
        }),
      ],
      LABELS,
    )
    expect(text).toBe(
      [
        "**You:** Draft MRK 4:1",
        "**Coordinator:** Here is a draft.",
        "**You:** Now check it",
        "**Coordinator:** It reads naturally.",
      ].join("\n\n"),
    )
  })

  it("copies a source chip as its quoted wording, not a wire token or the legend", () => {
    const chip = buildSourceChip({
      chipId: "c1",
      fileId: "f1",
      cellId: "cell-1",
      canonicalRef: "MRK 4:1",
      selection: "And he began again to teach by the sea side",
    })
    const { wire, display } = serializeWithChips("What does ⟦chip:c1⟧ mean here?", [chip])
    const text = formatTranscriptMarkdown(
      [makeRun({ prompt: display, wireContent: wire, items: [{ id: "t1", kind: "text", text: "It frames the parable." }] })],
      LABELS,
    )
    expect(text).toContain(
      '**You:** What does "And he began again to teach by the sea side" mean here?',
    )
    expect(text).not.toContain("⟦ctx:")
    expect(text).not.toContain("file_id=")
    expect(text).not.toContain("## Context")
  })

  it("keeps the typed slash command rather than the prompt it expanded into", () => {
    const text = formatTranscriptMarkdown(
      [
        makeRun({
          prompt: "/draft",
          wireContent: "Draft every untranslated line in the open chapter, one at a time.",
          items: [{ id: "t1", kind: "text", text: "Drafting." }],
        }),
      ],
      LABELS,
    )
    expect(text).toContain("**You:** /draft")
    expect(text).not.toContain("every untranslated line")
  })

  it("drops NEXT: suggestion markers, which render as buttons and never as text", () => {
    const text = formatTranscriptMarkdown(
      [
        makeRun({
          items: [
            { id: "t1", kind: "text", text: "Drafted three verses." },
            { id: "t2", kind: "text", text: "Done.\n\nNEXT: Check the drafts\nNEXT: Draft the next chapter" },
          ],
        }),
      ],
      LABELS,
    )
    expect(text).toContain("**Coordinator:** Drafted three verses.\n\nDone.")
    expect(text).not.toContain("NEXT:")
  })

  it("reports a failed run instead of dropping the turn", () => {
    const text = formatTranscriptMarkdown(
      [makeRun({ status: "error", errorMessage: "Provider timed out." })],
      LABELS,
    )
    expect(text).toBe("**You:** Draft MRK 4:1\n\n**Coordinator:** Provider timed out.")
  })

  it("is empty with no runs, so the caller can skip the clipboard write", () => {
    expect(formatTranscriptMarkdown([], LABELS)).toBe("")
  })
})

describe("userTurnText / assistantTurnText", () => {
  it("falls back to the display prompt when a run carries no wire text", () => {
    const run = makeRun({ prompt: "  Draft MRK 4:1  ", wireContent: undefined })
    expect(userTurnText(run)).toBe("Draft MRK 4:1")
  })

  it("joins only prose items, in arrival order, skipping tool activity", () => {
    const run = makeRun({
      items: [
        { id: "t1", kind: "text", text: "First." },
        { id: "x1", kind: "tool", step: 1, tool: "read", summary: "MRK 4", ok: true },
        { id: "t2", kind: "text", text: "Second." },
      ],
    })
    expect(assistantTurnText(run)).toBe("First.\n\nSecond.")
  })
})
