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
//
// AQU-1528 added the corpus question between the pick and the review: "Its
// Source" (sibling case) or "One of its Targets" (chain case), neither
// preselected. So `pick()` below answers it, and the cases that are about the
// question itself live in their own describe at the bottom.
//
// AQU-1544 added the end state the flow never had: the link was saved but the
// upstream's files did not arrive. Those cases are in their own describe too.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { UserError } from "@/lib/errors/user-error"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { isLinkSeedFailed, resetLinkSeedStatusForTests } from "@/lib/sync/link-seed-status"
import { pickSelectOption } from "@/test-utils/select"
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
// AQU-1605: the chain case now also asks WHICH of the upstream's translations
// becomes this project's source. Mocked at the loader, like the preview above:
// which lanes a caller may see is the server's answer (the read wall), pinned in
// auth-worker's source-linking-lane-choice.test.ts. One lane by default, because
// a single lane is pre-filled — so every case that predates this slice reads
// exactly as it did, with the lane simply carried on the request.
const loadUpstreamLaneChoices = vi.fn()

vi.mock("@/lib/sync/link-source-preview", () => ({
  loadLinkSourcePreview: (...args: unknown[]) => loadLinkSourcePreview(...args),
  loadUpstreamLaneChoices: (...args: unknown[]) => loadUpstreamLaneChoices(...args),
}))

const ONE_LANE = [{ id: "lane-upstream-default", label: "French" }]
const TWO_LANES = [
  { id: "lane-quebec", label: "Quebec French" },
  { id: "lane-france", label: "France French" },
]

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

// AQU-1559: the preview now carries one ROW per upstream file — the confirm
// step's checkbox list — and the count the step prints follows what is still
// checked. Built from names here so the cases that predate the list read exactly
// as they did, with every file checked on arrival.
function previewOf(upstreamName: string, names: string[], clashing: string[] = []) {
  const clash = new Set(clashing.map((n) => n.toLowerCase()))
  const files = names.map((name) => ({
    id: `up-${name}`,
    name,
    clashes: clash.has(name.toLowerCase()),
  }))
  return {
    upstreamName,
    files,
    fileCount: files.length,
    clashingNames: files.filter((f) => f.clashes).map((f) => f.name),
  }
}

const UPSTREAM_FILES = ["MAT", "MRK", "LUK"]
// A clashing row's checkbox carries its "same name here" marker in its
// accessible name, so match on the file name's start rather than the whole.
const fileCheckbox = (name: string) =>
  screen.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) })

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

// AQU-1544: the one sentence every entry point shows for a failed first sync.
const SEED_FAILED =
  "The link to the source project was saved, but its files have not arrived here yet. " +
  "Try again to bring them in."
const tryAgainButton = () => screen.getByRole("button", { name: "Try again" })
const reviewButton = () => screen.getByRole("button", { name: "Review what will be added" })

const corpusRadio = (which: "source" | "target") =>
  screen.getByRole("radio", {
    name: which === "source" ? /^Its Source/i : /^One of its Targets/i,
  })

async function pick(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  // AQU-1528: the corpus is a required answer, so every path through the flow
  // gives one. "source" keeps the pre-AQU-1528 cases posting what they pinned.
  corpus: "source" | "target" = "source",
) {
  await user.click(screen.getByRole("combobox", { name: "Source project" }))
  await user.click(await screen.findByRole("option", { name }))
  await user.click(corpusRadio(corpus))
  // AQU-1605: the chain case waits for the lane list — pre-filled at one lane,
  // which is what the default mock returns.
  if (corpus === "target") {
    await screen.findByRole("combobox", { name: "Which of its translations?" })
  }
  // AQU-1526: the pick alone links nothing — it opens the confirm step.
  await user.click(reviewButton())
  await waitFor(() => expect(screen.queryByRole("button", { name: "Review what will be added" })).toBeNull())
}

beforeEach(() => {
  linkProjectSource.mockReset()
  triggerLinkSync.mockReset()
  resetLinkSeedStatusForTests()
  loadLinkSourcePreview.mockReset()
  loadLinkSourcePreview.mockResolvedValue(previewOf("English Source", UPSTREAM_FILES))
  loadUpstreamLaneChoices.mockReset()
  loadUpstreamLaneChoices.mockResolvedValue(ONE_LANE)
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
    triggerLinkSync.mockResolvedValue(true)
    const { onLinked } = renderSection(700)

    await pick(user, "English Source")
    await user.click(linkButton())

    await waitFor(() => expect(triggerLinkSync).toHaveBeenCalledWith("tok", PROJECT_ID))
    // AQU-1544: a self-heal that worked is an ordinary success — the parent is
    // told and nothing about a failure is shown.
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(SEED_FAILED)).toBeNull()
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
    loadLinkSourcePreview.mockResolvedValue(
      previewOf("English Source", UPSTREAM_FILES, ["MRK"]),
    )
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
    loadLinkSourcePreview.mockResolvedValue(previewOf("English Source", UPSTREAM_FILES))
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
    loadLinkSourcePreview.mockResolvedValue(previewOf("Fresh Project", []))
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

    loadLinkSourcePreview.mockResolvedValue(
      previewOf("English Source", UPSTREAM_FILES, ["MRK"]),
    )
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

// AQU-1528 — the corpus question. Before this slice the flow hard-coded
// consumes='source', so the CHAIN case (this project translates one of the
// upstream's TRANSLATIONS, e.g. French → Chaluba) was reachable only while
// creating a project: a team that decided on it afterwards had to delete and
// rebuild the downstream project, which is the workaround AQU-1010 exists to
// remove. These tests pin that the flow asks, that it refuses to guess, and
// that each answer reaches the server as the link shape it means.
describe("LinkSourceSection — corpus choice (AQU-1528)", () => {
  // WHY: the two answers build different products — a sibling translation of
  // the same original vs. a link onto the upstream's output. A default would
  // silently build one of them, so the flow has to ask and has to wait, and
  // the way forward (and with it the link action, which is only reachable
  // through it) stays shut until it has an answer.
  it("asks which corpus after a pick and will not go forward until one is chosen", async () => {
    const user = userEvent.setup()
    renderSection(700)

    // Nothing to ask about before an upstream is on the table.
    expect(screen.queryByText("Which corpus should become this project's source?")).toBeNull()

    await user.click(screen.getByRole("combobox", { name: "Source project" }))
    await user.click(await screen.findByRole("option", { name: "English Source" }))

    expect(
      screen.getByText("Which corpus should become this project's source?"),
    ).toBeTruthy()
    // Both offered, neither preselected.
    expect(corpusRadio("source").getAttribute("aria-checked")).toBe("false")
    expect(corpusRadio("target").getAttribute("aria-checked")).toBe("false")
    expect(reviewButton().hasAttribute("disabled")).toBe(true)

    await user.click(corpusRadio("target"))
    // AQU-1605: the chain case has a second question. With one lane it is
    // pre-filled, so the step opens as soon as the list lands.
    await screen.findByRole("combobox", { name: "Which of its translations?" })
    await waitFor(() => expect(reviewButton().hasAttribute("disabled")).toBe(false))
    expect(linkProjectSource).not.toHaveBeenCalled()
  })

  // WHY: the step that was impossible on an established project. "One of its
  // Targets" has to reach the server as consumes='target' — the shape that
  // makes the upstream's TRANSLATIONS this project's source text. `gate` is
  // left off on purpose: the route defaults it to 'validated', which is the
  // "only validated upstream translations flow through" behaviour the chain
  // case is specified to have, and is what creation sends too.
  it("links the chain case as a live consumes-target link", async () => {
    const user = userEvent.setup()
    linkProjectSource.mockResolvedValue({
      projectId: PROJECT_ID,
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "target",
      gate: "validated",
      previousSourceProjectId: null,
      seeded: true,
    })
    const { onLinked } = renderSection(700)

    await pick(user, "English Source", "target")

    // The confirm step says which corpus, not just how many files — the count
    // reads identically for either answer.
    expect(await screen.findByText("consumes translations")).toBeTruthy()
    expect(screen.getByText("gate: validated only")).toBeTruthy()

    await user.click(linkButton())

    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1))
    expect(linkProjectSource).toHaveBeenCalledWith("tok", PROJECT_ID, {
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "target",
      // AQU-1605: the upstream lane the chain link consumes — pre-filled here,
      // since this upstream has one translation the caller may see.
      laneId: "lane-upstream-default",
    })
  })

  // WHY: the sibling case is the one AQU-1525 shipped and the one most teams
  // still want; adding a second option must not change what it posts or how it
  // is described on the way in.
  it("still links the sibling case as a live consumes-source link", async () => {
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
    renderSection(700)

    await pick(user, "English Source", "source")

    expect(await screen.findByText("consumes source")).toBeTruthy()
    // The validated-only gate badge belongs to the chain case — a sibling link
    // consumes the upstream's source, which has no validation gate to show.
    expect(screen.queryByText("gate: validated only")).toBeNull()

    await user.click(linkButton())

    await waitFor(() =>
      expect(linkProjectSource).toHaveBeenCalledWith("tok", PROJECT_ID, {
        sourceProjectId: "proj-upstream",
        mode: "live",
        consumes: "source",
      }),
    )
  })

  // WHY: a Detach-then-relink is the only way to change upstream (AQU-1525's
  // "Decisions already made"), and it must not inherit the previous answer —
  // the corpus is exactly what someone re-linking is likely to be changing.
  it("asks again after a successful link", async () => {
    const user = userEvent.setup()
    linkProjectSource.mockResolvedValue({
      projectId: PROJECT_ID,
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "target",
      gate: "validated",
      previousSourceProjectId: null,
      seeded: true,
    })
    const { onLinked } = renderSection(700)

    await pick(user, "English Source", "target")
    await user.click(linkButton())
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1))

    // Back at the picker with no upstream and no corpus carried over.
    await user.click(screen.getByRole("combobox", { name: "Source project" }))
    await user.click(await screen.findByRole("option", { name: "English Source" }))
    expect(corpusRadio("source").getAttribute("aria-checked")).toBe("false")
    expect(corpusRadio("target").getAttribute("aria-checked")).toBe("false")
    expect(reviewButton().hasAttribute("disabled")).toBe(true)
  })
})

// AQU-1605 — WHICH of the upstream's translations the chain case consumes.
//
// Why these tests exist: "One of its Targets" used to send no lane, and the
// server read whichever of the upstream's lanes carried the empty legacy tag. An
// upstream translating into several languages could only be chained from on one
// of them, by accident of history. The flow now asks — and only about lanes this
// caller may see, which is the server's answer, not the picker's.
describe("LinkSourceSection — which upstream translation (AQU-1605)", () => {
  it("asks only for the chain case", async () => {
    const user = userEvent.setup()
    renderSection(700)

    await user.click(screen.getByRole("combobox", { name: "Source project" }))
    await user.click(await screen.findByRole("option", { name: "English Source" }))
    await user.click(corpusRadio("source"))

    expect(screen.queryByText("Which of its translations?")).toBeNull()
    expect(loadUpstreamLaneChoices).not.toHaveBeenCalled()
  })

  it("will not go forward until one of several lanes is chosen, and sends it", async () => {
    const user = userEvent.setup()
    loadUpstreamLaneChoices.mockResolvedValue(TWO_LANES)
    linkProjectSource.mockResolvedValue({
      projectId: PROJECT_ID,
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "target",
      gate: "validated",
      laneId: "lane-france",
      previousSourceProjectId: null,
      seeded: true,
    })
    const { onLinked } = renderSection(700)

    await user.click(screen.getByRole("combobox", { name: "Source project" }))
    await user.click(await screen.findByRole("option", { name: "English Source" }))
    await user.click(corpusRadio("target"))

    await screen.findByRole("combobox", { name: "Which of its translations?" })
    expect(reviewButton().hasAttribute("disabled")).toBe(true)

    await pickSelectOption("Which of its translations?", "France French")
    await waitFor(() => expect(reviewButton().hasAttribute("disabled")).toBe(false))

    await user.click(reviewButton())
    // The picker is off screen by now, so the confirm step names the lane
    // itself — otherwise it reads identically for every lane of the upstream.
    expect(await screen.findByText("translation: France French")).toBeTruthy()

    await user.click(linkButton())
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1))
    expect(linkProjectSource).toHaveBeenCalledWith("tok", PROJECT_ID, {
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "target",
      laneId: "lane-france",
    })
  })

  it("offers exactly the lanes the server returned", async () => {
    // A read-walled member gets back the one lane they are granted, of an
    // upstream that has several. The flow must not add a default lane to that.
    const user = userEvent.setup()
    loadUpstreamLaneChoices.mockResolvedValue([{ id: "lane-granted", label: "Quebec French" }])
    renderSection(700)

    await user.click(screen.getByRole("combobox", { name: "Source project" }))
    await user.click(await screen.findByRole("option", { name: "English Source" }))
    await user.click(corpusRadio("target"))

    const select = await screen.findByRole("combobox", { name: "Which of its translations?" })
    await user.click(select)
    const options = await screen.findAllByRole("option")
    expect(options.map((o) => o.textContent)).toEqual(["Quebec French"])
  })

  it("says so, with a retry, when the lane list cannot be read", async () => {
    const user = userEvent.setup()
    loadUpstreamLaneChoices.mockRejectedValueOnce(new Error("boom"))
    renderSection(700)

    await user.click(screen.getByRole("combobox", { name: "Source project" }))
    await user.click(await screen.findByRole("option", { name: "English Source" }))
    await user.click(corpusRadio("target"))

    expect(await screen.findByText("Couldn't load this project's translations.")).toBeTruthy()
    expect(reviewButton().hasAttribute("disabled")).toBe(true)

    loadUpstreamLaneChoices.mockResolvedValue(ONE_LANE)
    await user.click(tryAgainButton())
    expect(
      await screen.findByRole("combobox", { name: "Which of its translations?" }),
    ).toBeTruthy()
  })
})

// AQU-1544 — the link was saved, the upstream's files did not arrive.
//
// Why these tests exist: saving a link and bringing its files in are two steps.
// The flow already retried the second one itself when the server said its seed
// had not run, but it never looked at whether that retry worked, and reported
// the link as done either way. On a failed first sync the settings card flipped
// to the linked state and the Import dialog closed, exactly as on success; the
// only trace was a 502 in the browser console. These cases reproduce that —
// the link request answers "not seeded" and the retry fails — and pin what the
// user is shown instead.
describe("LinkSourceSection — the first sync failed (AQU-1544)", () => {
  const NOT_SEEDED = {
    projectId: PROJECT_ID,
    sourceProjectId: "proj-upstream",
    mode: "live",
    consumes: "source",
    gate: "validated",
    previousSourceProjectId: null,
    seeded: false,
  }

  async function linkWithFailedSync(user: ReturnType<typeof userEvent.setup>) {
    linkProjectSource.mockResolvedValue(NOT_SEEDED)
    triggerLinkSync.mockResolvedValue(false)
    const rendered = renderSection(700)
    await pick(user, "English Source")
    await user.click(linkButton())
    await screen.findByText(SEED_FAILED)
    return rendered
  }

  // WHY: the step that used to pass silently. The success callback is what
  // closes the Import dialog and flips the settings card, so it must not fire
  // while the files are missing — and the user must be told, in a plain
  // sentence with a way to retry, not left with an unexplained empty list.
  it("says the link was saved but the files have not arrived, offers a retry, and does not report success", async () => {
    const user = userEvent.setup()
    const { onLinked } = await linkWithFailedSync(user)

    expect(screen.getByRole("alert").textContent).toContain(SEED_FAILED)
    expect(tryAgainButton()).toBeTruthy()
    expect(onLinked).not.toHaveBeenCalled()
    // One retry by the flow itself, before it gives up and says so.
    expect(triggerLinkSync).toHaveBeenCalledTimes(1)
    // The project IS linked now, so the picker is gone: offering to pick an
    // upstream again would be offering a second link.
    expect(screen.queryByRole("combobox", { name: "Source project" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Link source project" })).toBeNull()
    // Nor does the card go on saying the project "owns its own source" and
    // inviting a link, directly above a message that the link was saved.
    expect(screen.queryByText(/This project owns its own source/)).toBeNull()
    // Parked for the page behind the flow (workspace banner).
    expect(isLinkSeedFailed(PROJECT_ID)).toBe(true)
  })

  // WHY: "a plain sentence a translator can act on". The server's refusal text
  // and the HTTP status are exactly what must not reach the screen.
  it("shows no status code or raw server error", async () => {
    const user = userEvent.setup()
    await linkWithFailedSync(user)

    const text = screen.getByRole("alert").textContent ?? ""
    expect(text).not.toMatch(/\b[45]\d\d\b/)
    expect(text).not.toMatch(/gateway|link sync failed|mirror sync/i)
  })

  // WHY: retrying must be safe to do twice. A second failure leaves the link
  // saved, the message up and the button live — and says the attempt failed,
  // because a notice that sits unchanged reads as a button that did nothing.
  it("keeps the message and the retry when trying again fails too", async () => {
    const user = userEvent.setup()
    const { onLinked } = await linkWithFailedSync(user)

    await user.click(tryAgainButton())

    await screen.findByText(/That attempt did not bring them in either/)
    expect(screen.getByText(SEED_FAILED)).toBeTruthy()
    expect(tryAgainButton().hasAttribute("disabled")).toBe(false)
    expect(triggerLinkSync).toHaveBeenCalledTimes(2)
    expect(triggerLinkSync).toHaveBeenLastCalledWith("tok", PROJECT_ID)
    expect(onLinked).not.toHaveBeenCalled()
    // Retrying re-runs the sync only. It never links a second time and never
    // unlinks.
    expect(linkProjectSource).toHaveBeenCalledTimes(1)
    expect(isLinkSeedFailed(PROJECT_ID)).toBe(true)
  })

  // WHY: the way out. Once the sync works the flow finishes exactly as a link
  // that seeded first time does — the parent refreshes (that is what makes the
  // files appear without a reload) and the message is gone.
  it("finishes as a normal link once trying again works", async () => {
    const user = userEvent.setup()
    const { onLinked } = await linkWithFailedSync(user)

    triggerLinkSync.mockResolvedValue(true)
    await user.click(tryAgainButton())

    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(SEED_FAILED)).toBeNull()
    expect(linkProjectSource).toHaveBeenCalledTimes(1)
    expect(isLinkSeedFailed(PROJECT_ID)).toBe(false)
  })

  // WHY: the regression guard for the common case. A link whose first sync
  // succeeds server-side must behave exactly as before — no message, no extra
  // sync, success reported.
  it("shows nothing and retries nothing when the server seeded the link itself", async () => {
    const user = userEvent.setup()
    linkProjectSource.mockResolvedValue({ ...NOT_SEEDED, seeded: true })
    const { onLinked } = renderSection(700)

    await pick(user, "English Source")
    await user.click(linkButton())

    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1))
    expect(triggerLinkSync).not.toHaveBeenCalled()
    expect(screen.queryByText(SEED_FAILED)).toBeNull()
    expect(isLinkSeedFailed(PROJECT_ID)).toBe(false)
  })
})

// AQU-1559 — picking WHICH of the upstream's files to follow. The confirm step
// used to state a count and offer no choice, so a team that wanted one book out
// of a whole Bible got all 66 and had to delete the rest by hand — and the link
// kept bringing the upstream's later files in as well. These tests pin the list,
// that everything the step already said now follows the selection, and that the
// request distinguishes the two outcomes: all files checked = follow the whole
// project (unchanged), anything unchecked = follow exactly this list.
describe("LinkSourceSection — picking upstream files (AQU-1559)", () => {
  // WHY: the default has to stay the behaviour every existing link has. Arriving
  // all-checked is what makes the stock press of "Link source project" the same
  // whole-project link as before, with the list there for the lead who wants
  // less.
  it("lists every upstream file checked, with the count equal to the list", async () => {
    const user = userEvent.setup()
    renderSection(700)

    await pick(user, "English Source")

    expect(await screen.findByText("Link to English Source?")).toBeTruthy()
    for (const name of UPSTREAM_FILES) {
      expect((fileCheckbox(name) as HTMLElement).getAttribute("aria-checked")).toBe("true")
    }
    expect(screen.getByText("3 source files will be added to this project.")).toBeTruthy()
    expect(
      screen.getByText(/follows the whole project, so files the source project adds later/i),
    ).toBeTruthy()
  })

  // WHY: the count is the promise the link keeps, so it has to be the number of
  // files still checked rather than the size of the upstream — and it has to say
  // out loud that a subset link stops following what the upstream gains later,
  // because the checkboxes alone cannot show that.
  it("follows the selection in the count and in what the link will keep receiving", async () => {
    const user = userEvent.setup()
    renderSection(700)

    await pick(user, "English Source")
    await user.click(await screen.findByRole("checkbox", { name: "LUK" }))

    expect(screen.getByText("2 source files will be added to this project.")).toBeTruthy()
    expect(
      screen.getByText(/only the files you picked.*will not arrive here on their own/i),
    ).toBeTruthy()
  })

  // WHY: an upstream can hold 66 files or more, so flipping them one at a time
  // is not a workflow. One control does all of them, both ways.
  it("checks and unchecks every file with one control", async () => {
    const user = userEvent.setup()
    renderSection(700)

    await pick(user, "English Source")
    const all = await screen.findByRole("checkbox", { name: "All files" })

    await user.click(all)
    for (const name of UPSTREAM_FILES) {
      expect(fileCheckbox(name).getAttribute("aria-checked")).toBe("false")
    }

    await user.click(all)
    for (const name of UPSTREAM_FILES) {
      expect(fileCheckbox(name).getAttribute("aria-checked")).toBe("true")
    }
  })

  // WHY: a link that follows no files is a mistake rather than a link — it could
  // never sync anything — so the step says what is missing and the action is
  // unavailable until a file is picked.
  it("refuses a link with nothing checked and says a file must be picked", async () => {
    const user = userEvent.setup()
    renderSection(700)

    await pick(user, "English Source")
    await user.click(await screen.findByRole("checkbox", { name: "All files" }))

    expect(screen.getByText("Pick at least one file to link.")).toBeTruthy()
    expect(screen.queryByText(/source files will be added/i)).toBeNull()
    expect(linkButton().hasAttribute("disabled")).toBe(true)

    await user.click(linkButton())
    expect(linkProjectSource).not.toHaveBeenCalled()
  })

  // WHY: the two outcomes are different products. A subset has to reach the
  // server as the picked UPSTREAM file ids — ids, so the selection survives a
  // rename upstream — and nothing else may travel with it.
  it("posts the picked upstream file ids for a subset link", async () => {
    const user = userEvent.setup()
    linkProjectSource.mockResolvedValue({
      projectId: PROJECT_ID,
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "source",
      gate: "validated",
      fileIds: ["up-MAT", "up-MRK"],
      previousSourceProjectId: null,
      seeded: true,
    })
    const { onLinked } = renderSection(700)

    await pick(user, "English Source")
    await user.click(await screen.findByRole("checkbox", { name: "LUK" }))
    await user.click(linkButton())

    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1))
    expect(linkProjectSource).toHaveBeenCalledWith("tok", PROJECT_ID, {
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "source",
      fileIds: ["up-MAT", "up-MRK"],
    })
  })

  // WHY: the regression guard on the unchanged half. Every file left checked
  // must post NO file list at all — that absence is what keeps the link
  // following the whole project, so a file the upstream gains later still
  // arrives. Sending the full list instead would silently pin the link.
  it("sends no file list when every file is left checked", async () => {
    const user = userEvent.setup()
    linkProjectSource.mockResolvedValue({
      projectId: PROJECT_ID,
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "source",
      gate: "validated",
      fileIds: null,
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
  })

  // WHY: an empty upstream has nothing to pick, so it must not fall into the
  // "nothing checked" refusal — it is a legitimate whole-project link whose
  // files arrive as the upstream gains them.
  it("links an empty upstream with no list and no file ids", async () => {
    const user = userEvent.setup()
    loadLinkSourcePreview.mockResolvedValue(previewOf("Fresh Project", []))
    linkProjectSource.mockResolvedValue({
      projectId: PROJECT_ID,
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "source",
      gate: "validated",
      fileIds: null,
      previousSourceProjectId: null,
      seeded: true,
    })
    const { onLinked } = renderSection(700)

    await pick(user, "English Source")

    expect(await screen.findByText(/no source files yet, so nothing will be added now/i)).toBeTruthy()
    expect(screen.queryByRole("checkbox", { name: "All files" })).toBeNull()
    expect(screen.queryByText("Pick at least one file to link.")).toBeNull()
    expect(linkButton().hasAttribute("disabled")).toBe(false)

    await user.click(linkButton())
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1))
    expect(linkProjectSource).toHaveBeenCalledWith("tok", PROJECT_ID, {
      sourceProjectId: "proj-upstream",
      mode: "live",
      consumes: "source",
    })
  })

  // WHY: the same-name warning is about what is COMING. Unchecking the clashing
  // file takes it out of the warning, and with no checked clash left the warning
  // goes entirely — otherwise the step would warn about a duplicate it is no
  // longer going to create.
  it("warns only about clashing files that are still checked", async () => {
    const user = userEvent.setup()
    loadLinkSourcePreview.mockResolvedValue(
      previewOf("English Source", UPSTREAM_FILES, ["MRK"]),
    )
    renderSection(700)

    await pick(user, "English Source")

    const warning = await screen.findByRole("alert")
    expect(warning.textContent).toContain("MRK")

    await user.click(fileCheckbox("MRK"))

    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByText("2 source files will be added to this project.")).toBeTruthy()
  })

  // WHY: backing out must forget the pick, not carry it into the next review —
  // the next upstream's files are different files, and a half-remembered
  // selection would link the wrong set.
  it("starts from all-checked again after cancelling back to the picker", async () => {
    const user = userEvent.setup()
    renderSection(700)

    await pick(user, "English Source")
    await user.click(await screen.findByRole("checkbox", { name: "LUK" }))
    expect(screen.getByText("2 source files will be added to this project.")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await user.click(reviewButton())

    expect(
      await screen.findByText("3 source files will be added to this project."),
    ).toBeTruthy()
    expect(linkProjectSource).not.toHaveBeenCalled()
  })
})
