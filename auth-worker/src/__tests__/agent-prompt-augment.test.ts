// AQU-AGENT prompt assembly — the approved-memory index rendering.
//
// WHY (adversarial-panel mem-M4 + mem-m1): the model must be TOLD which memories
// a human edited (so it does not silently re-propose over human-owned notes) and
// the index must be capped so a large project cannot blow the prompt — with an
// explicit overflow pointer to read_memory so nothing is silently dropped.
import { describe, it, expect } from "vitest"
import { buildAugmentSystemPrompt } from "../lib/agent/prompt-augment"
import type { MemoryContext, MemoryIndexEntry } from "../../../db/shared/agent-memory"

function ctx(memoryIndex: MemoryIndexEntry[], brief = ""): MemoryContext {
  return { brief, memoryIndex, readMemory: async () => null }
}

describe("buildAugmentSystemPrompt — memory index", () => {
  it("annotates human-edited entries and adds the ask-don't-repropose rule (mem-M4)", () => {
    const prompt = buildAugmentSystemPrompt({
      memory: ctx([
        { path: "glossary/grace.md", firstLine: "grace → gracia", humanEdited: true },
        { path: "observations/x.md", firstLine: "seen once", humanEdited: false },
      ]),
    })
    // Human-edited entry carries the marker; the clean one does not.
    expect(prompt).toContain("glossary/grace.md [human-edited]: grace → gracia")
    expect(prompt).toContain("observations/x.md: seen once")
    expect(prompt).not.toContain("observations/x.md [human-edited]")
    // The ask-don't-repropose instruction is present.
    expect(prompt).toContain("do not silently re-propose over them")
  })

  it("caps the rendered index at 50 entries and points overflow at read_memory (mem-m1)", () => {
    const entries: MemoryIndexEntry[] = Array.from({ length: 63 }, (_, i) => ({
      path: `observations/n${i}.md`,
      firstLine: `line ${i}`,
      humanEdited: false,
    }))
    const prompt = buildAugmentSystemPrompt({ memory: ctx(entries) })

    // First 50 render; the 51st (index 50) does not appear as its own line.
    const rendered = prompt.split("\n").filter((l) => l.startsWith("- observations/n"))
    expect(rendered).toHaveLength(50)
    expect(prompt).toContain("observations/n0.md")
    expect(prompt).toContain("observations/n49.md")
    expect(prompt).not.toContain("- observations/n50.md:")
    // Overflow pointer accounts for the remaining 13.
    expect(prompt).toContain("and 13 more")
    expect(prompt).toContain("read_memory")
  })
})

describe("buildAugmentSystemPrompt — conversation language", () => {
  it("keeps conversational replies aligned with the user instead of the translation target", () => {
    const prompt = buildAugmentSystemPrompt({ memory: ctx([]) })

    expect(prompt).toContain("language of the user's latest message")
    expect(prompt).toContain("including greetings, headings, explanations, and questions")
    expect(prompt).toContain("Translation drafts, explicitly quoted translation examples")
    expect(prompt).toContain("Never greet or otherwise converse in that target language")
    expect(prompt).toContain("only if that is also unclear, use English")
    expect(prompt).not.toContain("project's working language")
  })

  it("uses the translator preference only as an ambiguity fallback", () => {
    const prompt = buildAugmentSystemPrompt({
      memory: ctx([]),
      fallbackResponseLanguage: "Tagalog",
    })

    expect(prompt).toContain("only if that is also unclear, use Tagalog")
    expect(prompt).not.toContain("Reply to the user in Tagalog")
  })
})
