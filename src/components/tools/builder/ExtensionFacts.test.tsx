// AQU-2260 (Sam, Oct 29): a permission chip says what its kind of permission
// means on a click, never on hover.
import { describe, it } from "vitest"
import { screen } from "@testing-library/react"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import { MetaChips } from "./ExtensionFacts"

describe("MetaChips", () => {
  it("opens a permission's rule on click", async () => {
    renderWithTooltips(<MetaChips mounts={["panel"]} scopes={["read:cells", "write:target"]} />)
    await expectClickNote(screen.getByRole("button", { name: /Reads verses/ }), "Allowed when you add it")
    await expectClickNote(screen.getByRole("button", { name: /Edits translations/ }), "Asks first · can be undone")
  })
})
