import { describe, expect, it, beforeEach, afterEach } from "vitest"
import {
  ALL_ORGS_PARAM,
  editorReturnFromLocation,
  isProjectEditorPath,
  membersPath,
  orgHomePath,
  orgKeyFromParam,
  orgPath,
  orgSettingsPath,
  parseOrgPath,
  projectEditorPath,
  projectSettingsPath,
  resumeOrgPath,
  safeReturnPath,
  swapOrgInPath,
  withEditorReturn,
  withSettingsReturn,
  ORG_STORAGE_KEY,
} from "./org-paths"

describe("orgKeyFromParam", () => {
  it("parses all and positive integers", () => {
    expect(orgKeyFromParam("all")).toBe(ALL_ORGS_PARAM)
    expect(orgKeyFromParam("7")).toBe(7)
  })

  it("rejects junk", () => {
    expect(orgKeyFromParam(undefined)).toBeNull()
    expect(orgKeyFromParam("")).toBeNull()
    expect(orgKeyFromParam("0")).toBeNull()
    expect(orgKeyFromParam("-1")).toBeNull()
    expect(orgKeyFromParam("1.5")).toBeNull()
    expect(orgKeyFromParam("abc")).toBeNull()
  })
})

describe("parseOrgPath", () => {
  it("parses home and nested tools", () => {
    expect(parseOrgPath("/orgs/all")).toEqual({ orgKey: "all", rest: "" })
    expect(parseOrgPath("/orgs/7")).toEqual({ orgKey: 7, rest: "" })
    expect(parseOrgPath("/orgs/7/members/matrix")).toEqual({
      orgKey: 7,
      rest: "/members/matrix",
    })
  })

  it("returns null outside /orgs", () => {
    expect(parseOrgPath("/")).toBeNull()
    expect(parseOrgPath("/project/p1")).toBeNull()
  })
})

describe("orgPath / swapOrgInPath", () => {
  it("builds nested paths and strips rest for all", () => {
    expect(orgHomePath(7)).toBe("/orgs/7")
    expect(orgPath(7, "/members")).toBe("/orgs/7/members")
    expect(orgPath("all", "/members")).toBe("/orgs/all")
  })

  it("preserves tool suffix when swapping concrete orgs", () => {
    expect(swapOrgInPath("/orgs/7/members/matrix", 9)).toBe("/orgs/9/members/matrix")
    expect(swapOrgInPath("/orgs/7/settings/identity", "all")).toBe("/orgs/all")
    expect(swapOrgInPath("/project/p1", 9)).toBe("/orgs/9")
  })
})

describe("convenience paths", () => {
  it("builds members / settings / project settings URLs", () => {
    expect(membersPath(3)).toBe("/orgs/3/members")
    expect(membersPath(3, "matrix")).toBe("/orgs/3/members/matrix")
    expect(orgSettingsPath(3, "identity")).toBe("/orgs/3/settings/identity")
    expect(projectSettingsPath("p1", "ai")).toBe("/project/p1/settings/ai")
  })
})

describe("editor settings handoff", () => {
  it("accepts same-origin relative return paths and rejects protocol-relative", () => {
    expect(safeReturnPath("/project/p1/editor")).toBe("/project/p1/editor")
    expect(safeReturnPath("/project/p1/editor/file/f1")).toBe("/project/p1/editor/file/f1")
    expect(safeReturnPath("//evil.example/phish")).toBeNull()
    expect(safeReturnPath("https://evil.example")).toBeNull()
    expect(safeReturnPath(null)).toBeNull()
  })

  it("recognizes this project's editor, including a file under it", () => {
    expect(isProjectEditorPath("/project/p1/editor", "p1")).toBe(true)
    expect(isProjectEditorPath("/project/p1/editor/file/f1", "p1")).toBe(true)
    expect(isProjectEditorPath("/project/p1/settings", "p1")).toBe(false)
    expect(isProjectEditorPath("/project/p2/editor", "p1")).toBe(false)
  })

  it("keeps ?return= on in-settings links and leaves other paths alone", () => {
    expect(withSettingsReturn("/project/p1/settings/ai", "/project/p1/editor"))
      .toBe("/project/p1/settings/ai?return=%2Fproject%2Fp1%2Feditor")
    expect(withSettingsReturn("/project/p1/settings", null)).toBe("/project/p1/settings")
  })

  it("merges ?return= into an overlay path that already has a query", () => {
    expect(withEditorReturn("/project/p1/rules?ruleId=r1", "/project/p1/editor/file/f1"))
      .toBe("/project/p1/rules?ruleId=r1&return=%2Fproject%2Fp1%2Feditor%2Ffile%2Ff1")
  })

  it("reads the editor handoff from the current editor URL or ?return=", () => {
    expect(editorReturnFromLocation("/project/p1/editor/file/f1", "", "p1"))
      .toBe("/project/p1/editor/file/f1")
    expect(editorReturnFromLocation("/project/p1/comments", "?return=%2Fproject%2Fp1%2Feditor", "p1"))
      .toBe("/project/p1/editor")
    expect(editorReturnFromLocation("/project/p1/comments", "", "p1")).toBeNull()
    expect(editorReturnFromLocation("/project/p1/comments", "?return=%2Fproject%2Fp2%2Feditor", "p1"))
      .toBeNull()
  })
})

describe("resumeOrgPath", () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it("defaults to /orgs/all", () => {
    expect(resumeOrgPath()).toBe("/orgs/all")
  })

  it("reads last concrete org", () => {
    localStorage.setItem(ORG_STORAGE_KEY, "42")
    expect(resumeOrgPath()).toBe("/orgs/42")
  })
})

describe("projectEditorPath", () => {
  it("returns the editor root", () => {
    expect(projectEditorPath("abc")).toBe("/project/abc/editor")
  })

  it("nests a file under the editor", () => {
    expect(projectEditorPath("abc", "GEN.sfm")).toBe("/project/abc/editor/file/GEN.sfm")
  })

  it("treats null/undefined fileId as the editor root", () => {
    expect(projectEditorPath("abc", null)).toBe("/project/abc/editor")
    expect(projectEditorPath("abc", undefined)).toBe("/project/abc/editor")
  })
})
