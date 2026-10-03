// AQU-1657: a harmonizer suggestion must say WHY — "the quotation that opens in
// JHN 6:26 ends here" — because nothing in the verse itself shows the problem.

import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { SmartEditPopover } from "./SmartEditPopover"
import { toSmartEditSuggestion } from "@/lib/harmonizer/client"

const base = {
  fileId: "JHN", cellId: "JHN 6:27", start: 12, end: 17, old: "seal.", new: "seal.”", confidence: 0.9,
  reasonValues: { openedIn: "JHN 6:26" },
}

function show(reasonKey: string) {
  const anchor = document.createElement("span")
  document.body.appendChild(anchor)
  render(
    <I18nProvider>
      <SmartEditPopover
        suggestion={toSmartEditSuggestion({ ...base, reasonKey })}
        anchor={anchor}
        onAccept={() => {}}
        onDismiss={() => {}}
        onClose={() => {}}
      />
    </I18nProvider>,
  )
}

describe("SmartEditPopover — harmonizer suggestions", () => {
  it("explains a closing quotation by naming the verse where it opened", () => {
    show("harmonizer.quotes.closeHere")
    expect(screen.getByText(/opens in JHN 6:26 ends here/)).toBeTruthy()
  })

  it("shows no raw key for a reason this client does not know", () => {
    show("harmonizer.future.check")
    expect(screen.queryByText(/harmonizer\.future/)).toBeNull()
  })
})
