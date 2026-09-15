import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { Concept } from "@/lib/terminology/types"
import { TargetDecoratedText } from "./EditorTable"

const concept: Concept = {
  id: "concept-light",
  sourceTerm: "light",
  renderings: [
    { rendering: "lumière", status: "preferred" },
    { rendering: "clarté", status: "admitted" },
    { rendering: "feu", status: "forbidden" },
  ],
  status: "active",
  createdAt: "2026-09-02T00:00:00.000Z",
}

function renderTarget(text: string, showKeyTermHighlights: boolean) {
  return render(
    <I18nProvider>
      <TargetDecoratedText
        text={text}
        concepts={[concept]}
        ranges={[]}
        showKeyTermHighlights={showKeyTermHighlights}
      />
    </I18nProvider>,
  )
}

describe("target key-term highlights", () => {
  it("marks preferred and admitted target renderings when enabled", () => {
    const { container } = renderTarget("La lumière apporte la clarté.", true)
    const matches = container.querySelectorAll("[data-source-term='light']")

    expect(matches).toHaveLength(2)
    expect(matches[0]).toHaveClass("terminology-highlight")
    expect(matches[1]).toHaveClass("terminology-highlight")
  })

  it("keeps target renderings interactive without showing the optional highlight", () => {
    const { container } = renderTarget("La lumière.", false)
    const match = container.querySelector("[data-source-term='light']")

    expect(match).not.toBeNull()
    expect(match).not.toHaveClass("terminology-highlight")
  })

  it("does not mark forbidden renderings as approved key terms", () => {
    const { container } = renderTarget("Le feu.", true)

    expect(container.querySelector("[data-source-term]")).toBeNull()
  })
})
