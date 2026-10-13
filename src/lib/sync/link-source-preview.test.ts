// AQU-1526 — the pre-link preview's clash arithmetic.
//
// Why a unit test under the component test: the clash rule is a data question
// with cases the UI cannot reach (an upstream that repeats a name, a project
// whose matching file differs only by case), and two entry points will render
// it — settings today, the Import dialog next (AQU-1527). Pinning the rule here
// keeps them from drifting apart.

import { describe, it, expect, vi, afterEach } from "vitest"
import type { ProjectFileSummary } from "./projects-read-types"
import { buildLinkSourcePreview, loadLinkSourcePreview } from "./link-source-preview"

const fetchProject = vi.fn()
vi.mock("./projects-read", () => ({
  fetchProject: (...args: unknown[]) => fetchProject(...args),
}))

function file(name: string): ProjectFileSummary {
  return { id: `f-${name}`, name, type: "codex", cellCount: 1 }
}

afterEach(() => {
  fetchProject.mockReset()
})

describe("buildLinkSourcePreview", () => {
  // WHY: the count is a promise the link has to keep — the preview says "3
  // files will be added" and three must turn up. Every non-deleted upstream
  // file mirrors (`file.create` is lane-relevant), so the count is the whole
  // upstream list, including files with no cells yet.
  it("counts every upstream file, not only the ones that clash", () => {
    const preview = buildLinkSourcePreview(
      { name: "English Source", files: [file("MAT"), file("MRK"), file("LUK")] },
      [file("MRK"), file("Notes")],
    )

    expect(preview.upstreamName).toBe("English Source")
    expect(preview.fileCount).toBe(3)
    expect(preview.clashingNames).toEqual(["MRK"])
  })

  // WHY: `MRK` and `mrk` read as the same file in the sidebar and the server
  // keys files by id, not name — so both really would sit there side by side.
  // A case-sensitive comparison would call that "no clash" and the user would
  // meet the duplicate afterwards, which is the exact surprise this slice
  // removes.
  it("matches names ignoring letter case and reports the upstream's spelling", () => {
    const preview = buildLinkSourcePreview(
      { name: "Upstream", files: [file("MRK")] },
      [file("mrk")],
    )

    // The upstream's spelling, because that is the name the mirrored copy
    // arrives under and the one that will be on screen.
    expect(preview.clashingNames).toEqual(["MRK"])
  })

  // WHY: the warning lists names, not rows. An upstream that holds two files
  // spelled the same way must not print the same line twice.
  it("lists a clashing name once however many upstream files spell it", () => {
    const preview = buildLinkSourcePreview(
      { name: "Upstream", files: [file("MRK"), { ...file("MRK"), id: "f-dup" }] },
      [file("MRK")],
    )

    expect(preview.clashingNames).toEqual(["MRK"])
    expect(preview.fileCount).toBe(2)
  })

  // WHY: no clash means no warning at all — only the count. A preview that
  // always warned would train people to click past it.
  it("reports no clash when no name matches", () => {
    const preview = buildLinkSourcePreview(
      { name: "Upstream", files: [file("MAT"), file("LUK")] },
      [file("GEN")],
    )

    expect(preview.clashingNames).toEqual([])
  })

  // WHY: an empty upstream is linkable (files arrive later as it gains them),
  // so it has to be distinguishable from a failed read — zero files, no clash,
  // and no error.
  it("reports zero for an upstream with no files yet", () => {
    const preview = buildLinkSourcePreview({ name: "Fresh Project", files: [] }, [file("MRK")])

    expect(preview.fileCount).toBe(0)
    expect(preview.clashingNames).toEqual([])
  })
})

// AQU-1559 — the rows the confirm step renders as checkboxes. The count and
// the warning become functions of what is checked, so the preview has to hand
// over the files themselves, each carrying its own identity and its own answer
// to the clash question.
describe("buildLinkSourcePreview — file rows (AQU-1559)", () => {
  // WHY: the selection travels to the server as UPSTREAM FILE IDS, not names.
  // Ids survive a rename upstream (which is the acceptance criterion: a renamed
  // picked file stays linked and the new name comes through); names do not. The
  // rows also keep the upstream's own order, because that is the order the lead
  // sees in the upstream project.
  it("returns one row per upstream file, in order, keyed by upstream file id", () => {
    const preview = buildLinkSourcePreview(
      { name: "Upstream", files: [file("MAT"), file("MRK"), file("LUK")] },
      [],
    )

    expect(preview.files).toEqual([
      { id: "f-MAT", name: "MAT", clashes: false },
      { id: "f-MRK", name: "MRK", clashes: false },
      { id: "f-LUK", name: "LUK", clashes: false },
    ])
  })

  // WHY: the warning has to follow the selection — unchecking a clashing file
  // takes it out of the warning, because a file that is not coming cannot
  // collide with anything. That is only possible if the clash is answered per
  // ROW rather than once for the whole upstream.
  it("marks each clashing row, case-insensitively, while the name list stays deduplicated", () => {
    const preview = buildLinkSourcePreview(
      {
        name: "Upstream",
        files: [file("MAT"), file("MRK"), { ...file("MRK"), id: "f-dup" }],
      },
      [file("mrk")],
    )

    expect(preview.files.map((f) => [f.id, f.clashes])).toEqual([
      ["f-MAT", false],
      ["f-MRK", true],
      ["f-dup", true],
    ])
    // Two rows to uncheck, one line of warning.
    expect(preview.clashingNames).toEqual(["MRK"])
  })

  // WHY: an empty upstream is linkable and shows no list. Returning `[]` rather
  // than omitting the field keeps the caller's "no rows ⇒ no list, link allowed"
  // test one check rather than two.
  it("returns no rows for an upstream with no files", () => {
    const preview = buildLinkSourcePreview({ name: "Fresh Project", files: [] }, [file("MRK")])

    expect(preview.files).toEqual([])
  })
})

describe("buildLinkSourcePreview — the file a row could replace (AQU-1679)", () => {
  // WHY: "replace the source in my existing file" needs to know WHICH file.
  // A name answers that only when it identifies one file on each side; anything
  // else must not offer the option, or the link would overwrite a guess.
  it("names this project's file only when the name is unique on both sides", () => {
    const preview = buildLinkSourcePreview(
      {
        name: "Upstream",
        files: [
          { id: "up-mat", name: "MAT" },
          { id: "up-mrk", name: "mrk" },
          { id: "up-luk-1", name: "LUK" },
          { id: "up-luk-2", name: "luk" },
          { id: "up-jhn", name: "JHN" },
          { id: "up-act", name: "ACT" },
        ],
      },
      [
        { id: "own-mrk", name: "MRK" },
        { id: "own-luk", name: "LUK" },
        { id: "own-jhn-1", name: "JHN" },
        { id: "own-jhn-2", name: "jhn" },
      ],
    )

    expect(preview.files.map((f) => [f.name, f.clashes, f.clashFileId])).toEqual([
      ["MAT", false, undefined],
      ["mrk", true, "own-mrk"],
      // Two upstream files share the name: neither can claim the one file here.
      ["LUK", true, undefined],
      ["luk", true, undefined],
      // Two files here share the name: which one is "the same file" is unknown.
      ["JHN", true, undefined],
      ["ACT", false, undefined],
    ])
  })
})

describe("loadLinkSourcePreview", () => {
  // WHY: the clash compares like with like only if both file lists come from
  // the same endpoint. This pins that it reads the upstream AND this project,
  // and that the upstream's list is the one counted (reversing the two would
  // silently preview the wrong project).
  it("reads both projects and counts the upstream's files", async () => {
    fetchProject.mockImplementation((projectId: string) =>
      projectId === "up"
        ? Promise.resolve({ name: "English Source", files: [file("MAT"), file("MRK")] })
        : Promise.resolve({ name: "This Project", files: [file("MRK")] }),
    )

    const preview = await loadLinkSourcePreview("tok", "mine", "up")

    expect(preview).toEqual({
      upstreamName: "English Source",
      files: [
        { id: "f-MAT", name: "MAT", clashes: false },
        // AQU-1679: this project's one MRK is the file the row could replace.
        { id: "f-MRK", name: "MRK", clashes: true, clashFileId: "f-MRK" },
      ],
      fileCount: 2,
      clashingNames: ["MRK"],
    })
  })

  // WHY: a failed read must reject, never resolve to a count of zero. Zero is
  // the "empty upstream, link away" state; reporting it for an unreadable
  // upstream would tell the user nothing is coming when three files are.
  it("rejects when a file list cannot be read", async () => {
    fetchProject.mockRejectedValue(new Error("HTTP 503"))

    await expect(loadLinkSourcePreview("tok", "mine", "up")).rejects.toThrow()
  })
})
