/**
 * AQU-2000: the note on the two punctuation rows must say WHY the checks use
 * the source's marks. A Spanish lane records a language; the conventions table
 * just has nothing special for it, so "this lane records no language" was
 * wrong there and sent leads looking for a language that was already set.
 */
import { beforeEach, describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RulesSurface } from "./RulesSurface"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/components/rules/OrgRulesPanel", () => ({ OrgRulesPanel: () => null }))
vi.mock("./BuiltinChecksList", () => ({
  BuiltinChecksList: ({ punctuationNote }: { punctuationNote?: string }) => (
    <p data-testid="punctuation-note">{punctuationNote}</p>
  ),
}))

type Lane = NonNullable<ProjectRecord["lanes"]>[number]

const lane = (legacyTag: string, name: string, position: number, extra: Partial<Lane> = {}): Lane => ({
  id: `lane-${position}`, role: "target", name, langCode: null, legacyTag, position, archivedAt: null, ...extra,
})

const projectWith = (lanes: Lane[], extra: Partial<ProjectRecord> = {}) => ({
  id: "p1",
  name: "P",
  sourceLanguage: "en",
  targetLanguage: "",
  lanes,
  createdAt: "2026-01-01T00:00:00.000Z",
  files: [],
  members: [],
  ...extra,
}) as unknown as ProjectRecord

function noteFor(project: ProjectRecord, activeLane = "") {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <RulesSurface
          project={project}
          projectId="p1"
          userRules={[]}
          builtinRules={[]}
          addRule={vi.fn()}
          updateRule={vi.fn()}
          deleteRule={vi.fn()}
          setBuiltinOverride={vi.fn()}
          infractions={new Map()}
          cells={[]}
          editingRuleId={null}
          setEditingRuleId={vi.fn()}
          activeLane={activeLane}
          onActiveLaneChange={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return screen.getByTestId("punctuation-note").textContent
}

describe("RulesSurface punctuation note (AQU-2000)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })))
  })

  it("names a recorded language the table has no conventions for, instead of saying it records none", () => {
    expect(noteFor(projectWith([lane("", "Spanish", 0)]))).toBe(
      "Judged by the source's own marks. Spanish has no special punctuation conventions.",
    )
  })

  it("still says the lane records no language when it really records none", () => {
    expect(noteFor(projectWith([lane("", "", 0)]))).toBe(
      "Judged by the source's own marks — this language lane records no language.",
    )
  })

  it("keeps the table's conventions note for a language the table knows", () => {
    expect(noteFor(projectWith([lane("", "Thai", 0)]))).toBe("Using Thai punctuation conventions.")
  })

  it("keeps the Language profile note when the profile fills the punctuation slot", () => {
    const project = projectWith([lane("", "Spanish", 0)], {
      languageProfile: { punctuation: { noTerminalMark: true } },
    } as Partial<ProjectRecord>)
    expect(noteFor(project)).toBe("Using the punctuation from the Language profile.")
  })
})
