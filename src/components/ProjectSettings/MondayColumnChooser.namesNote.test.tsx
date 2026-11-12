// AQU-1989 (Sam, 2026-10-20): the amber "who will see these names" note shows
// in Airtable's field list as well as Monday's, worded for each.
import { describe, expect, it } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"

import { MondayColumnChooser } from "./MondayColumnChooser"
import { AIRTABLE_CHOOSER_COPY } from "@/lib/airtable/ui-copy"
import { AIRTABLE_COLUMN_PROFILE } from "@/lib/airtable/types"
import type { MondayMetricKey } from "@/lib/monday/types"

function Airtable({ initial }: { initial: MondayMetricKey[] }) {
  const [selected, setSelected] = useState<Set<MondayMetricKey>>(() => new Set(initial))
  return (
    <MondayColumnChooser
      rows={[]}
      boardColumns={[]}
      boardName="Episode progress"
      selected={selected}
      onChange={setSelected}
      profile={AIRTABLE_COLUMN_PROFILE}
      copy={AIRTABLE_CHOOSER_COPY}
      testIdPrefix="airtable"
    />
  )
}

describe("the names note in Airtable's field list", () => {
  it("shows in amber, naming the table, only while a names field is ticked", () => {
    render(<Airtable initial={["completion_pct"]} />)
    expect(screen.queryByTestId("airtable-names-note")).toBeNull()

    fireEvent.click(screen.getByRole("checkbox", { name: /^Translators/ }))
    const note = screen.getByTestId("airtable-names-note")
    expect(note.getAttribute("role")).toBe("note")
    expect(note.textContent).toBe("Everyone who can see Episode progress in Airtable will see these names.")
    expect(note.className).toMatch(/\bbg-amber-50\b/)

    fireEvent.click(screen.getByRole("checkbox", { name: /^Translators/ }))
    expect(screen.queryByTestId("airtable-names-note")).toBeNull()
  })

  it("shows straight away when the table already brings Project manager in ticked", () => {
    render(<Airtable initial={["project_manager"]} />)
    expect(screen.getByTestId("airtable-names-note").textContent).toContain("Episode progress in Airtable")
    expect(screen.queryByTestId("monday-names-note")).toBeNull()
  })
})

