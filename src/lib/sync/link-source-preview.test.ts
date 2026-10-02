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
