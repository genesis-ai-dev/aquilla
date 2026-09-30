// WHY: translators need the TaBiThA checks to be readable at a glance (the
// quoted phrase, what it means, what to check) and must never see raw
// `<<name>>` markup. A verse TaBiThA doesn't cover is a normal empty state,
// and a failed lookup must not look like "no checks exist".

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TabithaBriefSection } from "./TabithaBriefSection"
import { __resetVerseBriefCache } from "@/lib/tabitha/verse-brief"

const PATH = "/en/passages/ACT/10/9/"
const getJwt = () => "jwt"

function mockBrief(body: unknown, status = 200) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }))
}

afterEach(() => {
  vi.restoreAllMocks()
  __resetVerseBriefCache()
})

describe("TabithaBriefSection", () => {
  it("shows the loading note, then each check with its quoted text", async () => {
    mockBrief({
      available: true,
      lwcText: "Peter went up to the roof of <<Simon's>> house to pray.",
      notes: [{ topic: "Intent/Result", meaning: "Purpose, not result.", check: "Check intent.", quotedText: "to pray" }],
      translatorNotes: [],
      culturalBackground: [{ term: "Joppa", summary: "A port city." }],
    })
    render(<TabithaBriefSection projectId="p1" passagePath={PATH} getJwt={getJwt} />)
    expect(screen.getByText(/The first time can take up to a minute/)).toBeInTheDocument()

    expect(await screen.findByText("Purpose, not result.")).toBeInTheDocument()
    expect(screen.getByText("Intent/Result")).toBeInTheDocument()
    expect(screen.getByText("“to pray”")).toBeInTheDocument()
    expect(screen.getByText("Check intent.")).toBeInTheDocument()
    expect(screen.getByText("Peter went up to the roof of Simon's house to pray.")).toBeInTheDocument()
    expect(screen.getByText("A port city.")).toBeInTheDocument()
  })

  it("shows the empty state for a verse TaBiThA doesn't cover", async () => {
    mockBrief({ available: false, lwcText: "", notes: [], translatorNotes: [], culturalBackground: [] })
    render(<TabithaBriefSection projectId="p1" passagePath={PATH} getJwt={getJwt} />)
    expect(await screen.findByText("No translation checks for this verse.")).toBeInTheDocument()
  })

  it("shows a load error distinct from the empty state", async () => {
    mockBrief({ error: "tabitha 429" }, 502)
    render(<TabithaBriefSection projectId="p1" passagePath={PATH} getJwt={getJwt} />)
    expect(await screen.findByText("Couldn't load translation checks.")).toBeInTheDocument()
  })
})
