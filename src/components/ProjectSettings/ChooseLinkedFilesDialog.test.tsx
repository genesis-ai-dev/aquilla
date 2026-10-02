// AQU-1560 — "Choose files" on the Source link card: add more of the upstream's
// files to an existing live link, without detaching and re-linking.
//
// Why these tests exist: after AQU-1559 the choice of files could only be made
// once, at link time. A team that linked MAT and later needed MRK had to detach
// (irreversible) and link again, and a file the upstream gained later never
// reached a fixed-list link at all. The card now opens the upstream's current
// file list — followed files checked and locked, the rest (including files the
// upstream gained since) unchecked — and confirming adds the newly checked ones.
// The server half (the files arriving whole) is pinned in auth-worker
// source-linking-add-files.test.ts and sync-worker link-sync-add-files.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { UserError } from "@/lib/errors/user-error"
import { SourceLinkSection, type SourceLinkSectionProps } from "./SourceLinkSection"

const addLinkedSourceFiles = vi.fn()

vi.mock("@/lib/sync/archive", () => ({
  addLinkedSourceFiles: (...args: unknown[]) => addLinkedSourceFiles(...args),
  runLinkSync: vi.fn(),
}))

const loadLinkSourcePreview = vi.fn()

vi.mock("@/lib/sync/link-source-preview", () => ({
  loadLinkSourcePreview: (...args: unknown[]) => loadLinkSourcePreview(...args),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "lead" }, loading: false }),
}))

vi.mock("@/components/dcs/DcsUpstreamPanel", () => ({ DcsUpstreamPanel: () => null }))

const PROJECT_ID = "proj-team-c"
const UPSTREAM_ID = "proj-gospels"

/** The upstream as the preview reads it now: MAT, MRK, LUK, and JHN — the one
 *  it gained after the link was made. `clashing` names share a name with a
 *  file this project already holds. */
function upstreamPreview(clashing: string[] = []) {
  const clash = new Set(clashing)
  const files = ["MAT", "MRK", "LUK", "JHN"].map((name) => ({
    id: `up-${name}`,
    name,
    clashes: clash.has(name),
  }))
  return {
    upstreamName: "Gospels",
    files,
    fileCount: files.length,
    clashingNames: files.filter((f) => f.clashes).map((f) => f.name),
  }
}

function renderCard(props: Partial<SourceLinkSectionProps> = {}) {
  const onFilesAdded = vi.fn()
  render(
    <I18nProvider>
      <SourceLinkSection
        projectId={PROJECT_ID}
        sourceProjectId={UPSTREAM_ID}
        sourceLinkMode="live"
        sourceLinkConsumes="source"
        sourceLinkGate="validated"
        sourceLinkCursor={40}
        sourceLinkFileIds={["up-MAT", "up-MRK"]}
        sourceLinkUpstreamFileCount={4}
        onDetached={vi.fn()}
        onFilesAdded={onFilesAdded}
        roleLevel={500}
        {...props}
      />
    </I18nProvider>,
  )
  return { onFilesAdded }
}

const chooseFilesButton = () => screen.queryByRole("button", { name: "Choose files" })
const addButton = () => screen.getByRole("button", { name: "Add files" })
const fileCheckbox = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) })

async function openDialog() {
  await userEvent.click(chooseFilesButton()!)
  await screen.findByRole("dialog")
  await screen.findByRole("checkbox", { name: /^MAT\b/ })
}

beforeEach(() => {
  addLinkedSourceFiles.mockReset()
  loadLinkSourcePreview.mockReset()
  loadLinkSourcePreview.mockResolvedValue(upstreamPreview())
})

describe("Source link card — who gets 'Choose files' (AQU-1560)", () => {
  it("is offered to a Project Lead on a live link", () => {
    renderCard()
    expect(chooseFilesButton()).not.toBeNull()
    expect((chooseFilesButton() as HTMLButtonElement).disabled).toBe(false)
  })

  // WHY: "a Contributor or Viewer does not get a working action" — the same
  // floor, and the same disabled-not-hidden treatment, as Detach beside it.
  it("is not a working action for a Contributor", async () => {
    renderCard({ roleLevel: 300 })
    expect((chooseFilesButton() as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(chooseFilesButton()!)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(loadLinkSourcePreview).not.toHaveBeenCalled()
  })

  // WHY: a one-time clone never syncs, so there is nothing that could bring a
  // file in; a legacy link with no recorded mode is not mirrored either.
  it("is not offered on a clone or a legacy link", () => {
    renderCard({ sourceLinkMode: "clone" })
    expect(chooseFilesButton()).toBeNull()
  })

  it("is not offered on a legacy link with no recorded mode", () => {
    renderCard({ sourceLinkMode: null })
    expect(chooseFilesButton()).toBeNull()
  })
})

describe("'Choose files' — the list (AQU-1560)", () => {
  // WHY: the three row states the issue names. Followed files are checked and
  // cannot be unchecked (stopping a file is AQU-1562); every other upstream
  // file is unchecked — including JHN, which the upstream gained after the
  // link was made and which a fixed-list link never received.
  it("shows linked files checked and locked, and every other upstream file unchecked", async () => {
    renderCard()
    await openDialog()

    expect(loadLinkSourcePreview).toHaveBeenCalledWith("tok", PROJECT_ID, UPSTREAM_ID)
    for (const name of ["MAT", "MRK"]) {
      const box = fileCheckbox(name)
      expect(box.getAttribute("aria-checked")).toBe("true")
      expect(box.hasAttribute("disabled") || box.getAttribute("aria-disabled") === "true").toBe(true)
    }
    expect(screen.getAllByText("already linked")).toHaveLength(2)
    for (const name of ["LUK", "JHN"]) {
      const box = fileCheckbox(name)
      expect(box.getAttribute("aria-checked")).toBe("false")
      expect(box.hasAttribute("disabled") || box.getAttribute("aria-disabled") === "true").toBe(false)
    }
    // Nothing new is checked yet, so there is nothing to confirm.
    expect(screen.getByText("Check a file above to add it to this link.")).toBeTruthy()
    expect((addButton() as HTMLButtonElement).disabled).toBe(true)
  })

  // WHY: "the confirm states how many files will be added" — and whether the
  // link stays a fixed list or becomes a whole-project one, which the
  // checkboxes alone do not show.
  it("states how many files will be added, and what kind of link results", async () => {
    renderCard()
    await openDialog()

    await userEvent.click(fileCheckbox("LUK"))
    expect(screen.getByText("1 source file will be added to this project.")).toBeTruthy()
    expect(screen.getByText(/follows only the files you picked/)).toBeTruthy()

    await userEvent.click(fileCheckbox("JHN"))
    expect(screen.getByText("2 source files will be added to this project.")).toBeTruthy()
    expect(screen.getByText(/follows the whole project/)).toBeTruthy()
  })

  // WHY: AQU-1526's warning, applied to what is being added: a checked file
  // sharing a name with one already here is named; an unchecked one is not.
  it("warns by name about a checked file that shares a name with one already here", async () => {
    loadLinkSourcePreview.mockResolvedValue(upstreamPreview(["LUK", "JHN"]))
    renderCard()
    await openDialog()
    expect(screen.queryByText(/already has a file with the same name/)).toBeNull()

    await userEvent.click(fileCheckbox("LUK"))

    const warning = screen.getByText(/already has a file with the same name/).closest("[role=alert]") as HTMLElement
    expect(within(warning).getByText("LUK")).toBeTruthy()
    expect(within(warning).queryByText("JHN")).toBeNull()
  })

  // WHY: a whole-project link already follows every file, and files the
  // upstream gains arrive on their own — the list says so, and offers nothing.
  it("offers nothing on a whole-project link", async () => {
    renderCard({ sourceLinkFileIds: null })
    await openDialog()

    expect(screen.getAllByText("already linked")).toHaveLength(4)
    expect(screen.getByText(/follows every file in the source project/)).toBeTruthy()
    expect((addButton() as HTMLButtonElement).disabled).toBe(true)
  })

  // WHY: a list the server could not read is said to be unread, with a retry —
  // never shown as an upstream with nothing to add.
  it("says so when the list cannot be loaded, and retries", async () => {
    loadLinkSourcePreview.mockRejectedValueOnce(new Error("offline"))
    renderCard()
    await userEvent.click(chooseFilesButton()!)

    expect(await screen.findByText(/Couldn't load the source project's file list/)).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))

    expect(await screen.findByRole("checkbox", { name: /^LUK\b/ })).toBeTruthy()
    expect(loadLinkSourcePreview).toHaveBeenCalledTimes(2)
  })
})

describe("'Choose files' — confirming (AQU-1560)", () => {
  // WHY: the slice's action. Only the newly checked upstream ids are sent —
  // never the locked ones — and the card is told to refresh once they are in.
  it("adds the newly checked files and refreshes the card", async () => {
    addLinkedSourceFiles.mockResolvedValue({ added: ["up-LUK"], fileIds: ["up-MAT", "up-MRK", "up-LUK"], complete: true })
    const { onFilesAdded } = renderCard()
    await openDialog()

    await userEvent.click(fileCheckbox("LUK"))
    await userEvent.click(addButton())

    expect(addLinkedSourceFiles).toHaveBeenCalledWith("tok", PROJECT_ID, ["up-LUK"])
    await waitFor(() => expect(onFilesAdded).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  // WHY: "if adding fails … the failure is stated, and trying again works —
  // no file is left half-added". The server answers `complete: false` when the
  // files did not all arrive; the dialog stays open on the same pick, says so,
  // and the same press resumes.
  it("states an incomplete add and lets the same press finish it", async () => {
    addLinkedSourceFiles
      .mockResolvedValueOnce({ added: ["up-LUK"], fileIds: ["up-MAT", "up-MRK"], complete: false })
      .mockResolvedValueOnce({ added: ["up-LUK"], fileIds: ["up-MAT", "up-MRK", "up-LUK"], complete: true })
    const { onFilesAdded } = renderCard()
    await openDialog()
    await userEvent.click(fileCheckbox("LUK"))

    await userEvent.click(addButton())

    expect(await screen.findByText(/didn't finish arriving/)).toBeTruthy()
    expect(onFilesAdded).not.toHaveBeenCalled()
    expect(fileCheckbox("LUK").getAttribute("aria-checked")).toBe("true")

    await userEvent.click(addButton())

    await waitFor(() => expect(onFilesAdded).toHaveBeenCalledTimes(1))
    expect(addLinkedSourceFiles).toHaveBeenLastCalledWith("tok", PROJECT_ID, ["up-LUK"])
  })

  it("states a refused request", async () => {
    addLinkedSourceFiles.mockRejectedValue(new UserError(403, '{"error":"role >= project_lead (500) required"}', "project"))
    const { onFilesAdded } = renderCard()
    await openDialog()
    await userEvent.click(fileCheckbox("JHN"))

    await userEvent.click(addButton())

    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(onFilesAdded).not.toHaveBeenCalled()
  })

  // WHY: "cancelling changes nothing" — no request, and the next open starts
  // from the server's list again rather than the abandoned pick.
  it("changes nothing on cancel", async () => {
    const { onFilesAdded } = renderCard()
    await openDialog()
    await userEvent.click(fileCheckbox("LUK"))

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(addLinkedSourceFiles).not.toHaveBeenCalled()
    expect(onFilesAdded).not.toHaveBeenCalled()
    await openDialog()
    expect(fileCheckbox("LUK").getAttribute("aria-checked")).toBe("false")
  })
})
