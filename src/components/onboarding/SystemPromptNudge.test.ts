// AQU-2342: the editor nudge asks for project instructions — the one text
// every AI draft reads — and stays quiet once any resolve, including old
// sources (a custom prompt, the brief) that migrate into them.
import { describe, expect, it } from "vitest"
import { shouldShowSystemPromptNudge } from "./SystemPromptNudge"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import type { ProjectRecord } from "@/lib/parsers/types"

const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p1",
    name: "P",
    createdAt: TWO_DAYS_AGO,
    files: [{ id: "f1", name: "GEN", type: "usfm", createdAt: TWO_DAYS_AGO, cellCount: 3 }],
    ...overrides,
  } as unknown as ProjectRecord
}

describe("shouldShowSystemPromptNudge", () => {
  it("nudges a project with content and no instructions", () => {
    expect(shouldShowSystemPromptNudge(project())).toBe(true)
  })

  it("still nudges when the only prompt is the built-in default", () => {
    const p = project({ completionSettings: { systemPrompt: DEFAULT_SYSTEM_PROMPT } } as Partial<ProjectRecord>)
    expect(shouldShowSystemPromptNudge(p)).toBe(true)
  })

  it("stays quiet once instructions are written", () => {
    expect(shouldShowSystemPromptNudge(project({ translationInstructions: "Plain register." }))).toBe(false)
  })

  it("stays quiet when an old custom prompt migrates into instructions", () => {
    const p = project({ completionSettings: { systemPrompt: "Keep names as in the 1999 Bible." } } as Partial<ProjectRecord>)
    expect(shouldShowSystemPromptNudge(p)).toBe(false)
  })

  it("stays quiet once dismissed", () => {
    expect(shouldShowSystemPromptNudge(project({ defaultPromptNudgeDismissedAt: TWO_DAYS_AGO }))).toBe(false)
  })
})
