// AQU-2655: the target chips of one run of text share ONE tooltip root instead
// of mounting a tooltip per chip. Each chip must still name its own term.

import { describe, it } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { Concept } from "@/lib/terminology/types"
import { TargetDecoratedText } from "@/components/EditorTable"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

function concept(sourceTerm: string, rendering: string): Concept {
  return {
    id: `concept-${sourceTerm}`,
    sourceTerm,
    renderings: [{ rendering, status: "preferred" }],
    status: "active",
    createdAt: "2026-11-20T00:00:00.000Z",
  }
}

describe("target key-term chip tooltip", () => {
  it("names the term of whichever chip is hovered", async () => {
    const { container } = renderWithTooltips(
      <I18nProvider>
        <TargetDecoratedText
          text="La lumière sur les eaux."
          concepts={[concept("light", "lumière"), concept("waters", "eaux")]}
          ranges={[]}
        />
      </I18nProvider>,
    )

    await expectTooltip(container.querySelector("[data-source-term='light']")!, "Managed term: light")
    await expectTooltip(container.querySelector("[data-source-term='waters']")!, "Managed term: waters")
  })
})
