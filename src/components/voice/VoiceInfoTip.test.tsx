// AQU-2260 (Sam, Oct 29): an explanation never opens on hover. The voice
// form's (i) opens its text on a click.

import { describe, it } from "vitest"
import { screen } from "@testing-library/react"
import { expectClickNote, renderWithTooltips } from "@/test-utils/tooltip"
import { VoiceInfoTip } from "./VoiceInfoTip"

describe("VoiceInfoTip", () => {
  it("opens its text on a click, never a hover", async () => {
    renderWithTooltips(<VoiceInfoTip label="About the accent" content="Default is just en." />)
    await expectClickNote(screen.getByRole("button", { name: "About the accent" }), "Default is just en.")
  })
})
