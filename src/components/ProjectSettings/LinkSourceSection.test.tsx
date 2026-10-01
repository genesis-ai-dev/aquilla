// AQU-1525 — linking an ESTABLISHED project to another project's source from
// Project Settings.
//
// Why these tests exist: the auth-worker has always accepted a link on a
// project that already has content, but the only caller was the Create New
// Project dialog. A project created without a link had no control anywhere in
// settings, so the workaround was to delete and rebuild it. These tests pin
// the entry point's contract — who sees it, what the picker may offer, the
// exact link shape posted (live / consumes source, the "Its Source" outcome),
// and that a refused link leaves the project linkable and retryable.
//
// AQU-1526 added the confirm step between the two: picking an upstream now
// reviews what the link will add (count + same-named-file warning) and a second
// press links. These tests go through that step rather than around it — the
// whole point of the slice is that nothing links straight off the picker.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { UserError } from "@/lib/errors/user-error"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { LinkSourceSection } from "./LinkSourceSection"

const linkProjectSource = vi.fn()
const triggerLinkSync = vi.fn()

vi.mock("@/lib/sync/archive", () => ({
  linkProjectSource: (...args: unknown[]) => linkProjectSource(...args),
  triggerLinkSync: (...args: unknown[]) => triggerLinkSync(...args),
}))

// AQU-1526: the confirm step's content. Mocked at the loader so these tests
// stay about the step's behaviour — the clash arithmetic itself is pinned in
// `src/lib/sync/link-source-preview.test.ts`.
const loadLinkSourcePreview = vi.fn()

vi.mock("@/lib/sync/link-source-preview", () => ({
  loadLinkSourcePreview: (...args: unknown[]) => loadLinkSourcePreview(...args),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "lead" }, loading: false }),
}))

let navigationProjects: CloudProjectSummary[] = []
let navigationError: string | null = null

vi.mock("@/hooks/useAccessibleProjects", () => ({
  useProjectsForNavigation: () => ({
    projects: navigationProjects,
    isLoading: false,
    error: navigationError,
    refresh: vi.fn(),
  }),
}))

const PROJECT_ID = "proj-established"

function summary(id: string, name: string, extra: Partial<CloudProjectSummary> = {}): CloudProjectSummary {
  // Viewer-level role: the picker must still offer it — viewer access to the
  // upstream is exactly what the server requires.
  return { id, name, role: { level: 100, name: "viewer", source: "member" }, ...extra } as unknown as CloudProjectSummary
}

function renderSection(roleLevel: number | null = 700) {
  const onLinked = vi.fn()
  render(
    <I18nProvider>
      <LinkSourceSection projectId={PROJECT_ID} onLinked={onLinked} roleLevel={roleLevel} />
    </I18nProvider>,
  )
  return { onLinked }
}

const linkButton = () => screen.getByRole("button", { name: "Link source project" })
const reviewButton = () => screen.getByRole("button", { name: "Review what will be added" })

async function pick(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Source project" }))
  await user.click(await screen.findByRole("option", { name }))
  // AQU-1526: the pick alone links nothing — it opens the confirm step.
  await user.click(reviewButton())
  await waitFor(() => expect(screen.queryByRole("button", { name: "Review what will be added" })).toBeNull())
}

beforeEach(() => {
  linkProjectSource.mockReset()
  triggerLinkSync.mockReset()
  loadLinkSourcePreview.mockReset()
  loadLinkSourcePreview.mockResolvedValue({
    upstreamName: "English Source",
    fileCount: 3,
    clashingNames: [],
  })
  navigationError = null
  navigationProjects = [
    summary("proj-upstream", "English Source"),
    summary("proj-viewer-only", "Someone Else's Project"),
    summary("proj-archived", "Retired Pilot", { archivedAt: new Date().toISOString() }),
    summary(PROJECT_ID, "This Project"),
  ]
})

describe("LinkSourceSection", () => {
  // WHY: the step that was impossible. A project lead on an established,
  // content-bearing project links it to an upstream from settings, and the
  // call is the same "Its Source" shape the create dialog posts — live mode,
  // consuming the upstream's source. Anything else (clone, consumes=target)
  // would be a different product.
  it("links to the chosen upstream as a live source link and tells the parent to refresh", async () => {
    const user = userEvent.setup()
    linkProjectSource.mockResolvedValue({
      projectId: PROJECT_ID,
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "source",
      gate: "validated",
      previousSourceProjectId: null,
      seeded: true,
    })
    const { onLinked } = renderSection(700)

    await pick(user, "English Source")
    await user.click(linkButton())

    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1))
    expect(linkProjectSource).toHaveBeenCalledWith("tok", PROJECT_ID, {
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "source",
    })
    // The server seeded inside the same call, so no client self-heal needed.
    expect(triggerLinkSync).not.toHaveBeenCalled()
  })

  // WHY (AQU-476/QA-BUG-1): a linked project that arrives with zero files has
  // no way to self-heal on its own. When the server reports it did not seed,
  // the client must trigger the mirror sync — the same fallback the create
  // dialog does, which an entry point added later is easy to forget.
  it("falls back to the client-side seed when the server reports it did not seed", async () => {
    const user = userEvent.setup()
    linkProjectSource.mockResolvedValue({
      projectId: PROJECT_ID,
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "source",
      gate: "validated",
      previousSourceProjectId: null,
      seeded: false,
    })
    renderSection(700)

    await pick(user, "English Source")
    await user.click(linkButton())

    await waitFor(() => expect(triggerLinkSync).toHaveBeenCalledWith("tok", PROJECT_ID))
  })

  // WHY: the picker's contents are an access question. Every project the user
  // can reach is fair game — including ones they did not create and ones where
  // they are only a Viewer, which is exactly the access the server demands of
  // the upstream — but never this project (the server 400s on a self-link) and
  // never an archived one.
  it("offers every accessible project except this one and archived ones", async () => {
    const user = userEvent.setup()
    renderSection(700)

    await user.click(screen.getByRole("combobox", { name: "Source project" }))
    expect(await screen.findByRole("option", { name: "English Source" })).toBeTruthy()
    expect(await screen.findByRole("option", { name: "Someone Else's Project" })).toBeTruthy()
    expect(screen.queryByRole("option", { name: "This Project" })).toBeNull()
    expect(screen.queryByRole("option", { name: "Retired Pilot" })).toBeNull()
  })

  // WHY: linking rewrites where a whole project reads its source from, so it
  // is project-lead work. A contributor must not be shown a control the server
  // would refuse — they get the reason instead.
  it("shows a contributor the project-lead note and no link control", () => {
    renderSection(300)

    expect(
      screen.getByText("Project lead or above required to link a source project."),
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Review what will be added" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Link source project" })).toBeNull()
    expect(screen.queryByRole("combobox", { name: "Source project" })).toBeNull()
  })

  // WHY: the server's 409 on this route is the cycle refusal and nothing else.
  // The generic "conflict" sentence would leave the user guessing why their
  // pick was rejected, and the project is still unlinked — so the choice and
  // the button have to survive for a retry.
  it("names the loop on a cycle refusal and stays retryable", async () => {
    const user = userEvent.setup()
    linkProjectSource.mockRejectedValueOnce(
      new UserError(409, "linking would create a cycle", "project"),
    )
    const { onLinked } = renderSection(700)

    await pick(user, "English Source")
    await user.click(linkButton())

    expect(await screen.findByText(/linking would create a loop/i)).toBeTruthy()
    expect(onLinked).not.toHaveBeenCalled()

    // Still the same pick, still actionable: a retry re-posts it.
    linkProjectSource.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "source",
      gate: "validated",
      previousSourceProjectId: null,
      seeded: true,
    })
    await user.click(linkButton())
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1))
    expect(linkProjectSource).toHaveBeenCalledTimes(2)
  })

  // WHY: a failed link must read as a failure, not as a silent no-op that
  // leaves the user unsure whether the project is now linked.
  it("surfaces a server error without reporting the project as linked", async () => {
    const user = userEvent.setup()
    linkProjectSource.mockRejectedValueOnce(new UserError(500, "link failed", "project"))
    const { onLinked } = renderSection(700)

    await pick(user, "English Source")
    await user.click(linkButton())

    expect(await screen.findByText(/something went wrong/i)).toBeTruthy()
    expect(onLinked).not.toHaveBeenCalled()
  })
})

// AQU-1526 — the confirm step. Linking an established project is additive, so a
// file it already holds under a name the upstream also uses ends up in the list
// twice: the original with the team's translations, the mirror with empty ones.
// That is the intended outcome, but it used to arrive unannounced, and on an
// established project it is the common case rather than the edge one. These
// tests pin that the duplicate is named BEFORE the link, that naming it does not
// refuse the link, and that a preview which could not be read never reads as an
// empty upstream.
describe("LinkSourceSection — pre-link preview (AQU-1526)", () => {
  // WHY: the surprise this slice removes. The clashing file is listed by name,
  // with the count, before anything is linked — and the confirm button is still
  // live beside the warning, because the decision was "add alongside and warn",
  // not "refuse".
  it("names the same-named files before linking and still allows the link", async () => {
    const user = userEvent.setup()
    loadLinkSourcePreview.mockResolvedValue({
      upstreamName: "English Source",
      fileCount: 3,
      clashingNames: ["MRK"],
    })
    linkProjectSource.mockResolvedValue({
      projectId: PROJECT_ID,
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "source",
      gate: "validated",
      previousSourceProjectId: null,
      seeded: true,
    })
    const { onLinked } = renderSection(700)

    await pick(user, "English Source")

    expect(await screen.findByText("Link to English Source?")).toBeTruthy()
    expect(
      screen.getByText("3 source files will be added to this project."),
    ).toBeTruthy()
    const warning = screen.getByRole("alert")
    expect(warning.textContent).toContain("This project already has a file with the same name:")
    expect(warning.textContent).toContain("MRK")
    expect(warning.textContent).toContain("will appear twice")
    // Warned, not blocked.
    expect(linkButton().hasAttribute("disabled")).toBe(false)

    await user.click(linkButton())
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1))
    expect(loadLinkSourcePreview).toHaveBeenCalledWith("tok", PROJECT_ID, "proj-upstream")
  })

  // WHY: a preview that always warned would train people to click past it. With
  // nothing to collide, the step is the count and nothing else.
  it("shows only the count when no upstream name matches", async () => {
    const user = userEvent.setup()
    loadLinkSourcePreview.mockResolvedValue({
      upstreamName: "English Source",
      fileCount: 3,
      clashingNames: [],
    })
    renderSection(700)

    await pick(user, "English Source")

    expect(
      await screen.findByText("3 source files will be added to this project."),
    ).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  // WHY: an empty upstream is a legitimate link — files arrive as the upstream
  // gains them. Saying "0 source files will be added" would read as a dead end,
  // so this state gets its own sentence and keeps the confirm action live.
  it("says nothing will be added yet for an empty upstream, and still links", async () => {
    const user = userEvent.setup()
    loadLinkSourcePreview.mockResolvedValue({
      upstreamName: "Fresh Project",
      fileCount: 0,
      clashingNames: [],
    })
    renderSection(700)

    await pick(user, "English Source")

    expect(await screen.findByText(/no source files yet, so nothing will be added now/i)).toBeTruthy()
    expect(screen.queryByText(/0 source files/)).toBeNull()
    expect(linkButton().hasAttribute("disabled")).toBe(false)
  })

  // WHY: a file list that could not be read must not be rendered as a count of
  // zero — zero means "empty upstream, link away", which is the opposite of
  // "we don't know what this will add". The user is told nothing was linked and
  // gets a retry.
  it("reports an unreadable upstream file list instead of a count, and retries", async () => {
    const user = userEvent.setup()
    loadLinkSourcePreview.mockRejectedValueOnce(new Error("HTTP 503"))
    renderSection(700)

    await pick(user, "English Source")

    expect(await screen.findByText(/couldn't load that project's file list/i)).toBeTruthy()
    expect(screen.queryByText(/source files will be added/i)).toBeNull()
    // Nothing is linked from a step that cannot say what it would do.
    expect(linkButton().hasAttribute("disabled")).toBe(true)
    expect(linkProjectSource).not.toHaveBeenCalled()

    loadLinkSourcePreview.mockResolvedValue({
      upstreamName: "English Source",
      fileCount: 3,
      clashingNames: ["MRK"],
    })
    await user.click(screen.getByRole("button", { name: "Try again" }))

    expect(
      await screen.findByText("3 source files will be added to this project."),
    ).toBeTruthy()
    expect(linkButton().hasAttribute("disabled")).toBe(false)
  })

  // WHY: the warning is only honest if backing out is real. Cancelling must
  // post nothing and leave the project unlinked, with the card back to the
  // picker so another upstream can be chosen.
  it("cancels back to the picker without linking", async () => {
    const user = userEvent.setup()
    const { onLinked } = renderSection(700)

    await pick(user, "English Source")
    await user.click(screen.getByRole("button", { name: "Cancel" }))

    expect(screen.getByRole("combobox", { name: "Source project" })).toBeTruthy()
    expect(reviewButton()).toBeTruthy()
    expect(linkProjectSource).not.toHaveBeenCalled()
    expect(onLinked).not.toHaveBeenCalled()
  })
})
