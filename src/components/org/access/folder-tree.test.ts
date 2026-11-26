/**
 * The folder tree is the only picture of who can open what. A project shown
 * twice would let two rows disagree about its people; a person listed both
 * as added here and as reaching here from above would be counted twice; and
 * a "+" on a language would offer to put something inside a leaf.
 */
import { describe, expect, it } from "vitest"

import { accessFolders, inheritedAccess, newChildKinds, planProjectMove, projectAttachments, undoMovePlan } from "./folder-tree"
import type { AccessTreeNode } from "./org-access-data"

const org = { type: "org" as const, id: "1", name: "Org" }
const teamA = { type: "team" as const, id: "a", name: "Asia" }
const teamB = { type: "team" as const, id: "b", name: "Africa" }
const shared = { type: "project" as const, id: "p1", name: "Shared" }
const loose = { type: "project" as const, id: "p2", name: "Alpha" }
const lane = { type: "lane" as const, id: "fr", name: "French" }

const leaf = (scope: AccessTreeNode["scope"], children: AccessTreeNode[] = []): AccessTreeNode => ({
  scope,
  children,
  directGrantees: [],
  inherited: [],
})

describe("accessFolders", () => {
  it("keeps folders between the org and its projects, folders first, and shows a project in two folders once", () => {
    const tree = [leaf(org, [leaf(loose), leaf(teamA, [leaf(shared, [leaf(lane)])]), leaf(teamB, [leaf(shared, [leaf(lane)])])])]
    const [root] = accessFolders(tree)
    expect(root.children.map((f) => f.node.scope.name)).toEqual(["Africa", "Asia", "Alpha"])
    // The server lists Asia first, so the project sits there; Africa does not repeat it.
    const asia = root.children[1]
    expect(asia.children.map((f) => f.node.scope.id)).toEqual(["p1"])
    expect(asia.children[0].path.map((s) => s.id)).toEqual(["1", "a", "p1"])
    expect(asia.children[0].children[0].node.scope).toEqual(lane)
    expect(root.children[0].children).toEqual([])
  })
})

describe("inheritedAccess", () => {
  it("lists each person once at their highest role from above, and leaves out people added here", () => {
    const { people, teams } = inheritedAccess(
      [{ userId: "here", displayName: "Here", roleLevel: 300 }],
      [
        { kind: "person", userId: "ruth", displayName: "Ruth", roleLevel: 400, from: shared },
        { kind: "person", userId: "ruth", displayName: "Ruth", roleLevel: 600, from: org },
        { kind: "person", userId: "here", displayName: "Here", roleLevel: 700, from: org },
        { kind: "team", roleLevel: 400, memberCount: 3, from: teamA },
      ],
    )
    expect(people).toEqual([{ userId: "ruth", displayName: "Ruth", roleLevel: 600, isGuest: false, from: org }])
    expect(teams).toEqual([{ team: teamA, roleLevel: 400, memberCount: 3 }])
  })
})

describe("newChildKinds", () => {
  it("makes folders and projects in the org, projects in a folder, languages in a project, nothing in a language", () => {
    expect(newChildKinds("org")).toEqual(["team", "project"])
    expect(newChildKinds("team")).toEqual(["project"])
    expect(newChildKinds("project")).toEqual(["lane"])
    expect(newChildKinds("lane")).toEqual([])
  })
})

describe("moving a project between folders", () => {
  // A move is a change of who can open the project: the folder it leaves
  // stops giving its people access, the folder it enters starts. The plan must
  // never leave the project in two places, and undo must restore the roles.
  const project = (inherited: AccessTreeNode["inherited"]): AccessTreeNode => ({ ...leaf(shared), inherited })

  it("reads a project's folders, and their roles, from what reaches it from a team", () => {
    const node = project([
      { kind: "team", roleLevel: 400, memberCount: 2, from: teamA },
      { kind: "person", userId: "u", displayName: "U", roleLevel: 600, from: org },
    ])
    expect(projectAttachments(node)).toEqual([{ folderId: "a", folderName: "Asia", roleLevel: 400 }])
  })

  it("moves into the destination with the role the old folder gave, then leaves every other folder", () => {
    const attachments = [
      { folderId: "a", folderName: "Asia", roleLevel: 400 },
      { folderId: "b", folderName: "Africa", roleLevel: 100 },
    ]
    expect(planProjectMove(attachments, "a", "c", 100)).toEqual({ attach: [{ folderId: "c", roleLevel: 400 }], detach: ["a", "b"] })
    expect(planProjectMove(attachments, "a", "b", 100)).toEqual({ attach: [], detach: ["a"] })
  })

  it("moves out to the organization by leaving every folder, and into a folder with the default role", () => {
    expect(planProjectMove([{ folderId: "a", folderName: "Asia", roleLevel: 400 }], "a", null, 100)).toEqual({ attach: [], detach: ["a"] })
    expect(planProjectMove([], null, "a", 100)).toEqual({ attach: [{ folderId: "a", roleLevel: 100 }], detach: [] })
  })

  it("does nothing for a move to where the project already is", () => {
    expect(planProjectMove([{ folderId: "a", folderName: "Asia", roleLevel: 400 }], "a", "a", 100)).toBeNull()
    expect(planProjectMove([], null, null, 100)).toBeNull()
  })

  it("undoes a move with the roles the folders had before", () => {
    const attachments = [{ folderId: "a", folderName: "Asia", roleLevel: 400 }]
    const plan = planProjectMove(attachments, "a", "c", 100)!
    expect(undoMovePlan(attachments, plan)).toEqual({ attach: [{ folderId: "a", roleLevel: 400 }], detach: ["c"] })
  })
})
