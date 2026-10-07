// AQU-1692 (Sam, Oct 7): a project has ONE narrator character. Adopting voices
// as the cast reuses the narrator it already has, found by a line it already
// reads (whatever it was renamed to) or by its name in any interface language,
// and only the first adoption names it from the interface.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { AdoptCastDialog, type VoiceCastAssignment } from "./AdoptCastDialog"
import type { BibleVoicesContextValue } from "./voices-context"
import { rutVoices } from "@/lib/bible-data/__fixtures__/ot-pack12"
import { buildVoiceIndex } from "@/lib/bible-data/voice-index"
import type { VoiceCastCell } from "@/lib/bible-data/voice-cast"
import { I18nProvider } from "@/lib/i18n/I18nProvider"

afterEach(cleanup)

const voices = {
  index: buildVoiceIndex(rutVoices()),
  shared: new Set<string>(),
  labelFor: (id: string) => ({ label: id.replace(/^person:/, "") }),
  showChips: true,
  showRails: true,
  showLinesBy: () => {},
  entities: {},
  maintainer: null,
} as unknown as BibleVoicesContextValue

// RUT 1:1 and 1:2 are read by the narrator alone; 1:17 by Ruth alone.
const cell = (verse: string, castName: string | null = null): VoiceCastCell =>
  ({ cellId: `c-${verse}`, ref: `RUT ${verse}`, castName }) as VoiceCastCell

function adopt(cells: VoiceCastCell[], castNames?: string[]): readonly VoiceCastAssignment[] {
  const onAdopt = vi.fn<(a: readonly VoiceCastAssignment[]) => void>()
  render(
    <I18nProvider>
      <AdoptCastDialog chapter="RUT 1" voices={voices} cells={() => cells} castNames={castNames} onAdopt={onAdopt} onClose={() => {}} />
    </I18nProvider>,
  )
  const dialog = screen.getByTestId("adopt-cast-dialog")
  fireEvent.click(within(dialog).getByRole("button", { name: /^Adopt \d+ lines?$/ }))
  return onAdopt.mock.calls[0][0]
}

const nameFor = (assignments: readonly VoiceCastAssignment[], verse: string) =>
  assignments.find((a) => a.cellId === `c-${verse}`)?.castName

describe("adopting names the narrator once per project", () => {
  it("names a first narrator from the interface", () => {
    expect(nameFor(adopt([cell("1:1"), cell("1:2")]), "1:1")).toBe("Narrator")
  })

  it("reuses the narrator a line already has, whatever it was renamed to", () => {
    expect(nameFor(adopt([cell("1:1", "Storyteller"), cell("1:2")]), "1:2")).toBe("Storyteller")
  })

  it("reuses a cast member named as the narrator in another interface language", () => {
    expect(nameFor(adopt([cell("1:1")], ["Ruth", "narrator"]), "1:1")).toBe("narrator")
  })

  it("leaves other speakers' names alone", () => {
    const assignments = adopt([cell("1:1", "Storyteller"), cell("1:17")])
    expect(nameFor(assignments, "1:17")).toBe("Ruth")
  })
})
