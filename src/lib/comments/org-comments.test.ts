import { describe, expect, it } from "vitest"
import {
  orgAuthorFilterOptions,
  orgFileFilterOptions,
  orgFileNames,
  orgProjectFilterOptions,
  orgProjectNames,
  type OrgCommentsProject,
} from "./org-comments"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

const projects: OrgCommentsProject[] = [
  { id: "p-oromo", name: "Oromo NT", files: [{ id: "f1", name: "Genesis" }] },
  { id: "p-marathi", name: "Marathi NT", files: [{ id: "f2", name: "Exodus" }] },
  { id: "p-quiet", name: "Russian OT", files: [{ id: "f3", name: "Ruth" }] },
]

function comment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    commentId: "c1",
    projectId: "p-oromo",
    scopeKind: "cell",
    fileId: "f1",
    cellId: "cell-1",
    parentCommentId: null,
    body: "body",
    resolved: false,
    authorId: "u-anastasia",
    authorLabel: "Anastasia",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  }
}

describe("orgProjectNames / orgFileNames", () => {
  it("maps ids to display names so no column or badge shows a uuid (AQU-295)", () => {
    expect(orgProjectNames(projects).get("p-marathi")).toBe("Marathi NT")
    expect(orgFileNames(projects).get("f2")).toBe("Exodus")
  })
})

describe("orgProjectFilterOptions", () => {
  it("lists only projects that have a comment in the loaded set, by name", () => {
    const options = orgProjectFilterOptions(projects, [
      comment({ projectId: "p-oromo" }),
      comment({ commentId: "c2", projectId: "p-marathi", fileId: "f2" }),
    ])
    expect(options).toEqual([
      { id: "p-marathi", name: "Marathi NT" },
      { id: "p-oromo", name: "Oromo NT" },
    ])
  })
})

describe("orgAuthorFilterOptions", () => {
  it("gives one entry per person, without the agent marker (AQU-1233)", () => {
    const options = orgAuthorFilterOptions([
      comment({ authorId: "u-tim", authorLabel: "Tim (via agent)" }),
      comment({ commentId: "c2", authorId: "u-tim", authorLabel: "Tim" }),
      comment({ commentId: "c3", authorId: "u-anastasia", authorLabel: "Anastasia" }),
    ])
    expect(options).toEqual([
      { id: "u-anastasia", label: "Anastasia" },
      { id: "u-tim", label: "Tim" },
    ])
  })

  it("falls back to the author id when the projection returned no label", () => {
    expect(orgAuthorFilterOptions([comment({ authorLabel: null })]))
      .toEqual([{ id: "u-anastasia", label: "u-anastasia" }])
  })
})

describe("orgFileFilterOptions", () => {
  const comments = [
    comment({ projectId: "p-oromo", fileId: "f1" }),
    comment({ commentId: "c2", projectId: "p-marathi", fileId: "f2" }),
  ]

  it("lists every commented file across projects when no project is picked", () => {
    expect(orgFileFilterOptions(comments, orgFileNames(projects)))
      .toEqual([{ id: "f2", name: "Exodus" }, { id: "f1", name: "Genesis" }])
  })

  it("narrows to the picked project so the two filters cannot contradict", () => {
    expect(orgFileFilterOptions(comments, orgFileNames(projects), "p-marathi"))
      .toEqual([{ id: "f2", name: "Exodus" }])
  })

  it("drops a file whose name is unknown instead of offering an unreadable option", () => {
    const options = orgFileFilterOptions(
      [...comments, comment({ commentId: "c3", fileId: "f-deleted" })],
      orgFileNames(projects),
    )
    expect(options.map((o) => o.id)).not.toContain("f-deleted")
  })

  it("ignores project-scoped threads, which belong to no file", () => {
    expect(orgFileFilterOptions(
      [comment({ scopeKind: "project", fileId: null, cellId: null })],
      orgFileNames(projects),
    )).toEqual([])
  })
})
