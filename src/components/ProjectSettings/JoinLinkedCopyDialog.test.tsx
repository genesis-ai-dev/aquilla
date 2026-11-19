// AQU-2549 part 1 — "Join a copy into my file" on the Source link card.
//
// A whole-project link brought the corrected "Genesis–Deuteronomy" in as a
// second copy beside the project's own translated file. The lead joins the
// copy into his file: the dialog shows the link dialog's comparison, refuses
// a copy with translations of its own, and keeps the half-the-lines check.
// The server halves: auth-worker source-linking-join-copy.test.ts and
// sync-worker link-sync-join-copy.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { resetAdoptedIdmlAlignmentForTests } from "@/lib/idml/link-adopted-align"
import { JoinLinkedCopyDialog } from "./JoinLinkedCopyDialog"

const fetchLinkedFileCopies = vi.fn()
const joinLinkedCopy = vi.fn()
vi.mock("@/lib/sync/link-join-copy", () => ({
  fetchLinkedFileCopies: (...args: unknown[]) => fetchLinkedFileCopies(...args),
  joinLinkedCopy: (...args: unknown[]) => joinLinkedCopy(...args),
}))
const fetchLinkFileMatches = vi.fn()
vi.mock("@/lib/sync/link-file-match", () => ({
  fetchLinkFileMatches: (...args: unknown[]) => fetchLinkFileMatches(...args),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "lead" }, loading: false }),
}))

const NAME = "3 Genesis–Deuteronomy"
const COPY = { fileId: "copy-gd", name: NAME, upstreamFileId: "up-gd", translated: false, suggestedFileId: "own-gd" }
const OWN = [
  { id: "own-gd", name: NAME },
  { id: "own-josh", name: "4 Joshua–Esther" },
]
function matchOf(extra: Record<string, unknown> = {}) {
  return {
    upstreamFileId: "up-gd", fileId: "own-gd", missing: false,
    upstreamLines: 1533, localLines: 1533, same: 1532, changed: 1, added: 0, kept: 0, canReplace: true,
    ...extra,
  }
}

function renderDialog() {
  const onJoined = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <I18nProvider>
      <JoinLinkedCopyDialog
        projectId="proj-pt"
        sourceProjectId="proj-bsb"
        open
        onOpenChange={onOpenChange}
        onJoined={onJoined}
      />
    </I18nProvider>,
  )
  return { onJoined, onOpenChange }
}

const joinButton = () => screen.getByRole("button", { name: "Join" })

beforeEach(() => {
  vi.clearAllMocks()
  resetAdoptedIdmlAlignmentForTests()
})

describe("JoinLinkedCopyDialog (AQU-2549 part 1)", () => {
  it("starts on the same-named file, shows how the two compare, and joins", async () => {
    const user = userEvent.setup()
    fetchLinkedFileCopies.mockResolvedValue({ copies: [COPY], ownFiles: OWN })
    fetchLinkFileMatches.mockResolvedValue([matchOf()])
    joinLinkedCopy.mockResolvedValue({ match: matchOf(), complete: true })
    const { onJoined, onOpenChange } = renderDialog()

    expect(await screen.findByText("1532 of 1533 lines are the same in both files.")).toBeTruthy()
    expect(fetchLinkFileMatches).toHaveBeenCalledWith("tok", "proj-pt", "proj-bsb", [
      { upstreamFileId: "up-gd", fileId: "own-gd" },
    ])
    await user.click(joinButton())

    await waitFor(() => expect(joinLinkedCopy).toHaveBeenCalledWith("tok", "proj-pt", "copy-gd", "own-gd"))
    expect(onJoined).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // WHY (Sam's pick, Nov 14): joining removes the copy, so work done on it
  // would end up on a deleted file. Refused, in one plain sentence.
  it("refuses a copy that has translations of its own, and says why", async () => {
    fetchLinkedFileCopies.mockResolvedValue({ copies: [{ ...COPY, translated: true }], ownFiles: OWN })
    renderDialog()

    expect((await screen.findByRole("alert")).textContent).toBe(
      `${NAME} can't be joined because it has translations of its own, which would end up on a deleted file.`,
    )
    expect(joinButton().hasAttribute("disabled")).toBe(true)
    expect(fetchLinkFileMatches).not.toHaveBeenCalled()
  })

  // WHY: the half-the-lines check every replace makes holds here too.
  it("will not join two files that are not the same material", async () => {
    fetchLinkedFileCopies.mockResolvedValue({ copies: [COPY], ownFiles: OWN })
    fetchLinkFileMatches.mockResolvedValue([matchOf({ same: 12, canReplace: false })])
    renderDialog()

    expect((await screen.findByRole("alert")).textContent).toBe(
      "These two files are not the same material: only 12 of 1533 lines match, so they can't be joined.",
    )
    expect(joinButton().hasAttribute("disabled")).toBe(true)
  })

  it("says so when there is no copy to join", async () => {
    fetchLinkedFileCopies.mockResolvedValue({ copies: [], ownFiles: OWN })
    renderDialog()
    expect(await screen.findByText("This project has no copies from the source project to join.")).toBeTruthy()
    expect(joinButton().hasAttribute("disabled")).toBe(true)
  })
})
