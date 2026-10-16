// AQU-1560/AQU-1562 — "Choose files" on the Source link card: change which of
// the upstream's files an existing live link follows, without detaching and
// re-linking.
//
// Why these tests exist: after AQU-1559 the choice of files could only be made
// once, at link time, and after AQU-1560 it could only grow. A team that linked
// MAT and later needed MRK had to detach (irreversible) and link again; a file
// the upstream gained later never reached a fixed-list link at all; and a team
// that linked a file by mistake, or that wanted one book to go its own way,
// had to delete the file (losing its translations) or cut every file loose.
//
// The card now opens the upstream's current file list — followed files checked,
// the rest (including files the upstream gained since, and files this project
// stopped following) unchecked. Checking adds; unchecking stops. Anything that
// carries a promise a checkbox does not goes through a confirm step first.
//
// The server halves are pinned in auth-worker source-linking-add-files.test.ts /
// source-linking-stop-files.test.ts and sync-worker link-sync-add-files.test.ts /
// link-sync-stop-files.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { UserError } from "@/lib/errors/user-error"
import { SourceLinkSection, type SourceLinkSectionProps } from "./SourceLinkSection"

const addLinkedSourceFiles = vi.fn()
const stopLinkedSourceFiles = vi.fn()
const loadLinkedSourceFileState = vi.fn()

vi.mock("@/lib/sync/archive", () => ({
  addLinkedSourceFiles: (...args: unknown[]) => addLinkedSourceFiles(...args),
  stopLinkedSourceFiles: (...args: unknown[]) => stopLinkedSourceFiles(...args),
  loadLinkedSourceFileState: (...args: unknown[]) => loadLinkedSourceFileState(...args),
  runLinkSync: vi.fn(),
}))

const loadLinkSourcePreview = vi.fn()

vi.mock("@/lib/sync/link-source-preview", () => ({
  loadLinkSourcePreview: (...args: unknown[]) => loadLinkSourcePreview(...args),
}))

// AQU-1679: the server's comparison of one of this project's files with the
// upstream file it could follow — mocked at the fetch, as in LinkSourceSection's
// tests; the pairing is pinned in `db/shared/link-file-match.test.ts`.
const fetchLinkFileMatches = vi.fn()

vi.mock("@/lib/sync/link-file-match", () => ({
  fetchLinkFileMatches: (...args: unknown[]) => fetchLinkFileMatches(...args),
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
const reviewButton = () => screen.getByRole("button", { name: "Review changes" })
const confirmButton = () => screen.getByRole("button", { name: "Confirm" })
const fileCheckbox = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) })

async function openDialog() {
  await userEvent.click(chooseFilesButton()!)
  await screen.findByRole("dialog")
  await screen.findByRole("checkbox", { name: /^MAT\b/ })
}

/** The dialog reads the link's state from the server on every open; by default
 *  it agrees with the card's props and nothing is stopped. */
function linkState(fileIds: string[] | null = ["up-MAT", "up-MRK"], stoppedFileIds: string[] = []) {
  return { fileIds, stoppedFileIds }
}

beforeEach(() => {
  addLinkedSourceFiles.mockReset()
  stopLinkedSourceFiles.mockReset()
  loadLinkedSourceFileState.mockReset()
  loadLinkSourcePreview.mockReset()
  loadLinkSourcePreview.mockResolvedValue(upstreamPreview())
  loadLinkedSourceFileState.mockResolvedValue(linkState())
  fetchLinkFileMatches.mockReset()
})

describe("Source link card — who gets 'Choose files' (AQU-1560)", () => {
  it("is offered to a Project Lead on a live link", () => {
    renderCard()
    expect(chooseFilesButton()).not.toBeNull()
    expect((chooseFilesButton() as HTMLButtonElement).disabled).toBe(false)
  })

  // WHY: "a Contributor or Viewer does not get a working action" — the same
  // floor, and the same disabled-not-hidden treatment, as Detach beside it.
  // AQU-1562 rides on this: it is also what stops them stopping or resuming a
  // file, which the server refuses independently.
  it("is not a working action for a Contributor", async () => {
    renderCard({ roleLevel: 300 })
    expect((chooseFilesButton() as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(chooseFilesButton()!)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(loadLinkSourcePreview).not.toHaveBeenCalled()
  })

  // WHY: a one-time clone never syncs, so there is nothing that could bring a
  // file in or be stopped; a legacy link with no recorded mode is not mirrored.
  it("is not offered on a clone or a legacy link", () => {
    renderCard({ sourceLinkMode: "clone" })
    expect(chooseFilesButton()).toBeNull()
  })

  it("is not offered on a legacy link with no recorded mode", () => {
    renderCard({ sourceLinkMode: null })
    expect(chooseFilesButton()).toBeNull()
  })
})

describe("'Choose files' — the list (AQU-1560/AQU-1562)", () => {
  // WHY: the row states the issues name. Followed files are checked — and since
  // AQU-1562 they can be unchecked, which is the whole slice; every other
  // upstream file is unchecked, including JHN, which the upstream gained after
  // the link was made and which a fixed-list link never received.
  it("shows followed files checked and unlockable, and every other upstream file unchecked", async () => {
    renderCard()
    await openDialog()

    expect(loadLinkSourcePreview).toHaveBeenCalledWith("tok", PROJECT_ID, UPSTREAM_ID)
    expect(loadLinkedSourceFileState).toHaveBeenCalledWith("tok", PROJECT_ID)
    for (const name of ["MAT", "MRK"]) {
      const box = fileCheckbox(name)
      expect(box.getAttribute("aria-checked")).toBe("true")
      expect(box.hasAttribute("disabled") || box.getAttribute("aria-disabled") === "true").toBe(false)
    }
    expect(screen.getAllByText("already linked")).toHaveLength(2)
    for (const name of ["LUK", "JHN"]) {
      const box = fileCheckbox(name)
      expect(box.getAttribute("aria-checked")).toBe("false")
      expect(box.hasAttribute("disabled") || box.getAttribute("aria-disabled") === "true").toBe(false)
    }
    // Nothing changed yet, so there is nothing to confirm.
    expect(screen.getByText(/Check a file above to add it to this link, or uncheck one/)).toBeTruthy()
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
  // upstream gains arrive on their own — so there is nothing to add. Since
  // AQU-1562 there is still something to DO: a file can be stopped.
  it("has nothing to add on a whole-project link, but still offers stopping", async () => {
    loadLinkedSourceFileState.mockResolvedValue(linkState(null))
    renderCard({ sourceLinkFileIds: null })
    await openDialog()

    expect(screen.getAllByText("already linked")).toHaveLength(4)
    expect(screen.getByText(/follows every file in the source project/)).toBeTruthy()
    expect((addButton() as HTMLButtonElement).disabled).toBe(true)

    await userEvent.click(fileCheckbox("MRK"))
    expect((reviewButton() as HTMLButtonElement).disabled).toBe(false)
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

  // WHY: the stopped/never-had distinction is the server's to make, and without
  // it the dialog must still work — off the card's own props, describing a check
  // as a plain add rather than promising a replacement that may not happen.
  it("still works when the server cannot say which files are stopped", async () => {
    loadLinkedSourceFileState.mockRejectedValue(new Error("older server"))
    renderCard()
    await openDialog()

    expect(screen.queryByText("stopped following")).toBeNull()
    await userEvent.click(fileCheckbox("LUK"))
    expect((addButton() as HTMLButtonElement).disabled).toBe(false)
  })
})

describe("'Choose files' — adding files (AQU-1560)", () => {
  // WHY: the slice's action, and still ONE press: adding a file this project
  // never had promises nothing a checkbox does not already say.
  it("adds the newly checked files and refreshes the card", async () => {
    addLinkedSourceFiles.mockResolvedValue({ added: ["up-LUK"], fileIds: ["up-MAT", "up-MRK", "up-LUK"], complete: true })
    const { onFilesAdded } = renderCard()
    await openDialog()

    await userEvent.click(fileCheckbox("LUK"))
    await userEvent.click(addButton())

    expect(addLinkedSourceFiles).toHaveBeenCalledWith("tok", PROJECT_ID, ["up-LUK"])
    expect(stopLinkedSourceFiles).not.toHaveBeenCalled()
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

describe("'Choose files' — stopping a file (AQU-1562)", () => {
  // WHY: "before anything changes, a confirm lists the files that will stop
  // being followed and states that they stay in the project with their
  // translations and will no longer receive upstream changes." Those exact
  // terms, because the alternatives this replaces — deleting the file, or
  // detaching — both lose something, and the lead has to be able to tell.
  it("names the file and says what happens to it before anything changes", async () => {
    renderCard()
    await openDialog()

    await userEvent.click(fileCheckbox("MRK"))
    await userEvent.click(reviewButton())

    expect(screen.getByText("Stop following this file:")).toBeTruthy()
    expect(screen.getByText("MRK")).toBeTruthy()
    expect(screen.getByText(/stays in this project with the source text it has now/)).toBeTruthy()
    expect(screen.getByText(/translations, validations and comments are untouched/)).toBeTruthy()
    expect(screen.getByText(/no longer receive the source project's changes/)).toBeTruthy()
    // "Every other linked file keeps syncing" — said, not just true.
    expect(screen.getByText(/Every other file this link follows keeps syncing/)).toBeTruthy()
    // Nothing has been sent yet: this is a confirm, not a report.
    expect(stopLinkedSourceFiles).not.toHaveBeenCalled()
  })

  it("stops the file on confirm and refreshes the card", async () => {
    stopLinkedSourceFiles.mockResolvedValue({ stopped: ["up-MRK"], fileIds: ["up-MAT"], wasWholeProject: false })
    const { onFilesAdded } = renderCard()
    await openDialog()

    await userEvent.click(fileCheckbox("MRK"))
    await userEvent.click(reviewButton())
    await userEvent.click(confirmButton())

    expect(stopLinkedSourceFiles).toHaveBeenCalledWith("tok", PROJECT_ID, ["up-MRK"])
    expect(addLinkedSourceFiles).not.toHaveBeenCalled()
    await waitFor(() => expect(onFilesAdded).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  // WHY: "stopping a file on a whole-project link … the confirm warns that new
  // upstream files will no longer arrive on their own". That is AQU-1559's rule
  // biting in the direction nobody asked for, so it is said out loud rather
  // than discovered later when a new book never shows up.
  it("warns on a whole-project link that later upstream files will stop arriving", async () => {
    loadLinkedSourceFileState.mockResolvedValue(linkState(null))
    stopLinkedSourceFiles.mockResolvedValue({ stopped: ["up-MRK"], fileIds: ["up-MAT", "up-LUK", "up-JHN"], wasWholeProject: true })
    renderCard({ sourceLinkFileIds: null })
    await openDialog()

    await userEvent.click(fileCheckbox("MRK"))
    await userEvent.click(reviewButton())

    expect(screen.getByText(/pins it to the remaining files/)).toBeTruthy()
    expect(screen.getByText(/no longer arrive here on their own/)).toBeTruthy()

    await userEvent.click(confirmButton())
    expect(stopLinkedSourceFiles).toHaveBeenCalledWith("tok", PROJECT_ID, ["up-MRK"])
  })

  // WHY: "unchecking every linked file cannot be confirmed; the dialog says at
  // least one file must stay linked and points to 'Detach from source'" — a
  // link following nothing could never sync, and detaching is the operation
  // that actually does this, with its own snapshot and its own confirmation.
  it("refuses to leave the link following nothing, and points at Detach", async () => {
    renderCard()
    await openDialog()

    await userEvent.click(fileCheckbox("MAT"))
    await userEvent.click(fileCheckbox("MRK"))

    const keepOne = screen.getByText(/At least one file must stay linked/)
    expect(keepOne.textContent).toMatch(/Detach from source/)
    expect((screen.getByRole("button", { name: "Review changes" }) as HTMLButtonElement).disabled).toBe(true)
    expect(stopLinkedSourceFiles).not.toHaveBeenCalled()

    // Checking something else to take their place makes it confirmable again:
    // the rule is about the selection left behind, not the boxes.
    await userEvent.click(fileCheckbox("LUK"))
    expect(screen.queryByText(/At least one file must stay linked/)).toBeNull()
    expect((reviewButton() as HTMLButtonElement).disabled).toBe(false)
  })

  // WHY: "Back" from the confirm is not a cancel — the pick survives, so a lead
  // who went to read the wording can change one box and go on.
  it("keeps the pick when the lead goes back from the confirm", async () => {
    renderCard()
    await openDialog()
    await userEvent.click(fileCheckbox("MRK"))
    await userEvent.click(reviewButton())

    await userEvent.click(screen.getByRole("button", { name: "Back" }))

    expect(fileCheckbox("MRK").getAttribute("aria-checked")).toBe("false")
    expect(stopLinkedSourceFiles).not.toHaveBeenCalled()
  })

  it("states a refused stop and sends nothing else", async () => {
    stopLinkedSourceFiles.mockRejectedValue(
      new UserError(409, '{"error":"at least one file must stay linked"}', "project"),
    )
    const { onFilesAdded } = renderCard()
    await openDialog()
    await userEvent.click(fileCheckbox("MRK"))
    await userEvent.click(fileCheckbox("LUK"))
    await userEvent.click(reviewButton())

    await userEvent.click(confirmButton())

    expect(await screen.findByRole("alert")).toBeTruthy()
    // Stopping comes first, so a refused stop means the add never ran — the
    // link is exactly as it was.
    expect(addLinkedSourceFiles).not.toHaveBeenCalled()
    expect(onFilesAdded).not.toHaveBeenCalled()
  })

  // WHY: one confirm can hold both, and the order matters — stopping first
  // means the add lands on the narrowed selection instead of being undone by it.
  it("stops before adding when one confirm does both", async () => {
    const calls: string[] = []
    stopLinkedSourceFiles.mockImplementation(async () => {
      calls.push("stop")
      return { stopped: ["up-MRK"], fileIds: ["up-MAT"], wasWholeProject: false }
    })
    addLinkedSourceFiles.mockImplementation(async () => {
      calls.push("add")
      return { added: ["up-LUK"], fileIds: ["up-MAT", "up-LUK"], complete: true }
    })
    renderCard()
    await openDialog()

    await userEvent.click(fileCheckbox("MRK"))
    await userEvent.click(fileCheckbox("LUK"))
    await userEvent.click(reviewButton())

    expect(screen.getByText("Stop following this file:")).toBeTruthy()
    expect(screen.getByText("Add this file:")).toBeTruthy()
    await userEvent.click(confirmButton())

    await waitFor(() => expect(calls).toEqual(["stop", "add"]))
  })
})

describe("'Choose files' — resuming a stopped file (AQU-1562)", () => {
  beforeEach(() => {
    loadLinkedSourceFileState.mockResolvedValue(linkState(["up-MAT"], ["up-MRK"]))
  })

  // WHY: "a stopped file appears unchecked in 'Choose files'", and it is marked
  // as such — the row otherwise looks exactly like a file this project never
  // had, while checking it does something quite different.
  it("shows a stopped file unchecked and badged", async () => {
    renderCard({ sourceLinkFileIds: ["up-MAT"] })
    await openDialog()

    expect(fileCheckbox("MRK").getAttribute("aria-checked")).toBe("false")
    expect(screen.getByText("stopped following")).toBeTruthy()
    expect(screen.getAllByText("already linked")).toHaveLength(1)
  })

  // WHY: "the resume confirm states that the file's source text will be
  // replaced with the upstream's current text." That is the one thing a resume
  // costs, and the lead has been editing the file in the meantime, so it cannot
  // be worded as a plain add.
  it("says the source text will be replaced, and that translations stay", async () => {
    addLinkedSourceFiles.mockResolvedValue({ added: ["up-MRK"], fileIds: ["up-MAT", "up-MRK"], complete: true })
    const { onFilesAdded } = renderCard({ sourceLinkFileIds: ["up-MAT"] })
    await openDialog()

    await userEvent.click(fileCheckbox("MRK"))
    await userEvent.click(reviewButton())

    expect(screen.getByText("Follow this file again:")).toBeTruthy()
    expect(screen.getByText(/source text will be replaced with the source project's current text/)).toBeTruthy()
    expect(screen.getByText(/translations, validations and comments stay/)).toBeTruthy()
    // Resuming IS the add request — the same route, which re-uses the same file.
    await userEvent.click(confirmButton())
    expect(addLinkedSourceFiles).toHaveBeenCalledWith("tok", PROJECT_ID, ["up-MRK"])
    expect(stopLinkedSourceFiles).not.toHaveBeenCalled()
    await waitFor(() => expect(onFilesAdded).toHaveBeenCalledTimes(1))
  })

  // WHY: the two are worded apart, and in one confirm both wordings appear
  // against the right files — a never-had file is not promised a replacement
  // of text it does not have.
  it("words a resume and a plain add apart in the same confirm", async () => {
    renderCard({ sourceLinkFileIds: ["up-MAT"] })
    await openDialog()

    await userEvent.click(fileCheckbox("MRK"))
    await userEvent.click(fileCheckbox("LUK"))
    await userEvent.click(reviewButton())

    const resume = screen.getByText("Follow this file again:").parentElement as HTMLElement
    expect(within(resume).getByText("MRK")).toBeTruthy()
    expect(within(resume).queryByText("LUK")).toBeNull()
    const add = screen.getByText("Add this file:").parentElement as HTMLElement
    expect(within(add).getByText("LUK")).toBeTruthy()
    expect(within(add).queryByText("MRK")).toBeNull()
  })

  // WHY: a resumed file is not a name clash with itself — it IS the file
  // already here, so AQU-1526's "this will appear twice" warning must not fire
  // on it. The whole point is that no second copy appears.
  it("does not warn about a name clash with the stopped file itself", async () => {
    loadLinkSourcePreview.mockResolvedValue(upstreamPreview(["MRK"]))
    renderCard({ sourceLinkFileIds: ["up-MAT"] })
    await openDialog()

    await userEvent.click(fileCheckbox("MRK"))

    expect(screen.queryByText(/already has a file with the same name/)).toBeNull()
  })
})

describe("'Choose files' — replacing the source of a file already here (AQU-1679)", () => {
  // The upstream's LUK shares a name with exactly one file this project has.
  function previewWithOwnLuke() {
    const preview = upstreamPreview(["LUK"])
    return {
      ...preview,
      files: preview.files.map((f) => (f.name === "LUK" ? { ...f, clashFileId: "own-luk" } : f)),
    }
  }
  function matchOf(extra: Record<string, unknown> = {}) {
    return {
      upstreamFileId: "up-LUK",
      fileId: "own-luk",
      missing: false,
      upstreamLines: 1151,
      localLines: 1151,
      same: 1151,
      changed: 0,
      added: 0,
      kept: 0,
      canReplace: true,
      ...extra,
    }
  }
  const replaceCheckbox = () =>
    screen.getByRole("checkbox", { name: "Replace the source in my existing LUK and keep its translations" })

  beforeEach(() => {
    loadLinkSourcePreview.mockResolvedValue(previewWithOwnLuke())
    addLinkedSourceFiles.mockResolvedValue({ added: ["up-LUK"], fileIds: ["up-MAT", "up-MRK", "up-LUK"], complete: true })
  })

  // WHY: the case the screenshot showed — a link that already exists, a lead
  // adding the file their team has been translating on its own. Until this the
  // dialog warned about the duplicate and offered nothing else.
  it("offers the replace option on a checked same-named file, and posts the pair through the confirm", async () => {
    fetchLinkFileMatches.mockResolvedValue([matchOf()])
    const { onFilesAdded } = renderCard()
    await openDialog()
    expect(screen.queryByRole("checkbox", { name: /^Replace the source/ })).toBeNull()

    await userEvent.click(fileCheckbox("LUK"))
    expect(replaceCheckbox().getAttribute("aria-checked")).toBe("false")
    expect(screen.getByText(/already has a file with the same name/)).toBeTruthy()

    await userEvent.click(replaceCheckbox())

    expect(await screen.findByText("1151 of 1151 lines are the same in both files.")).toBeTruthy()
    expect(fetchLinkFileMatches).toHaveBeenCalledWith("tok", PROJECT_ID, UPSTREAM_ID, [
      { upstreamFileId: "up-LUK", fileId: "own-luk" },
    ])
    // Not a copy any more: no duplicate warning, not counted as added.
    expect(screen.queryByText(/already has a file with the same name/)).toBeNull()
    expect(screen.queryByText(/source file will be added/)).toBeNull()
    expect(
      screen.getByText("1 file you already have will take its source from this link and keep its translations."),
    ).toBeTruthy()

    // A replace promises something a checkbox does not, so it is reviewed first.
    await userEvent.click(reviewButton())
    expect(screen.getByText("Replace the source in this file you already have:")).toBeTruthy()
    expect(screen.getByText(/No second copy is added/)).toBeTruthy()
    await userEvent.click(confirmButton())

    expect(addLinkedSourceFiles).toHaveBeenCalledWith("tok", PROJECT_ID, ["up-LUK"], [
      { upstreamFileId: "up-LUK", fileId: "own-luk" },
    ])
    await waitFor(() => expect(onFilesAdded).toHaveBeenCalledTimes(1))
  })

  // WHY: sharing a name is not sharing content; and turning the option off must
  // put the lead straight back on the plain add, with the request AQU-1560 made.
  it("holds the add while a replace is not possible, and adds as a copy once it is turned off", async () => {
    fetchLinkFileMatches.mockResolvedValue([matchOf({ same: 20, changed: 1131, canReplace: false })])
    renderCard()
    await openDialog()
    await userEvent.click(fileCheckbox("LUK"))

    await userEvent.click(replaceCheckbox())

    expect(await screen.findByText(/not the same material: only 20 of 1151 lines match/)).toBeTruthy()
    expect(reviewButton().hasAttribute("disabled")).toBe(true)

    await userEvent.click(replaceCheckbox())

    await userEvent.click(addButton())
    expect(addLinkedSourceFiles).toHaveBeenCalledWith("tok", PROJECT_ID, ["up-LUK"])
  })

  // WHY: a chain link's source is the upstream's translations, which a file
  // imported on its own cannot line up with; the server refuses the request.
  it("does not offer the option on a chain link", async () => {
    renderCard({ sourceLinkConsumes: "target" })
    await openDialog()

    await userEvent.click(fileCheckbox("LUK"))

    expect(screen.queryByRole("checkbox", { name: /^Replace the source/ })).toBeNull()
    expect(screen.getByText(/already has a file with the same name/)).toBeTruthy()
  })

  // WHY: a stopped file IS the file already here — resuming it brings the
  // upstream's text into that same file. Offering to replace "the other" file
  // would pair the upstream with the wrong one.
  it("does not offer the option on a stopped file", async () => {
    loadLinkedSourceFileState.mockResolvedValue(linkState(["up-MAT", "up-MRK"], ["up-LUK"]))
    renderCard()
    await openDialog()

    await userEvent.click(fileCheckbox("LUK"))

    expect(screen.queryByRole("checkbox", { name: /^Replace the source/ })).toBeNull()
  })
})
