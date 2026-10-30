// AQU-2260 (Sam, Oct 29): the "Live preview" mark says what the preview runs
// against on a click, never on hover.
import { describe, it } from "vitest"
import { screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import type { ToolManifest } from "../../../../shared/tools/manifest"
import { ExtensionPreview } from "./ExtensionPreview"

const manifest: ToolManifest = { name: "Word count", description: "", scopes: ["read:cells"], mounts: ["inline"], apiRev: 7 }

describe("ExtensionPreview", () => {
  it("says the preview uses sample verses, on click", async () => {
    renderWithTooltips(<MemoryRouter><ExtensionPreview source="<p>hi</p>" manifest={manifest} /></MemoryRouter>)
    await expectClickNote(screen.getByRole("button", { name: /Live preview/ }), "Sample verses. Nothing in your project changes.")
  })
})
