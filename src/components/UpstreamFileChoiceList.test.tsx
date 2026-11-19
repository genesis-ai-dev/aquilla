// AQU-2549: what the replace comparison says while the source project is
// still importing the file. It used to read "only 0 of 0 lines match", which
// sounds like "these are different files"; it is a wait, not a mismatch.

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { ReplaceMatchNote } from "./UpstreamFileChoiceList"
import type { LinkFileMatch } from "@/lib/sync/link-file-match"

const MISSING: LinkFileMatch = {
  upstreamFileId: "up-gd",
  fileId: "own-gd",
  missing: true,
  upstreamLines: 0,
  localLines: 0,
  same: 0,
  changed: 0,
  added: 0,
  kept: 0,
  canReplace: false,
}

function note(match: LinkFileMatch) {
  return render(
    <I18nProvider>
      <ReplaceMatchNote state={{ status: "ready", match }} />
    </I18nProvider>,
  )
}

describe("ReplaceMatchNote (AQU-2549 part 3)", () => {
  it("says the file is still importing instead of 0 of 0 lines", () => {
    note({ ...MISSING, importing: true })
    expect(screen.getByRole("status").textContent).toMatch(/still importing in the source project/i)
    expect(screen.queryByText(/0 of 0/)).toBeNull()
  })

  it("keeps the mismatch sentence for a file that is not importing", () => {
    note(MISSING)
    expect(screen.getByRole("alert").textContent).toMatch(/not the same material/i)
  })
})
