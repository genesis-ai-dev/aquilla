import { describe, it, expect, beforeEach } from "vitest"
import { authorNameFor, resetLocalAuthorNameForTests, setLocalAuthorName } from "./local-author-name"

beforeEach(() => {
  window.localStorage.clear()
  resetLocalAuthorNameForTests()
})

describe("the author name for edits (AQU-2259)", () => {
  it("is the account when signed in, whatever else is set", () => {
    setLocalAuthorName("Ana")
    expect(authorNameFor("ana.k", "old-project-name")).toBe("ana.k")
  })

  it("is the Preferences name when signed out", () => {
    setLocalAuthorName("Ana")
    expect(authorNameFor(null, "old-project-name")).toBe("Ana")
  })

  it("keeps a name set the old way on a project until Preferences has one", () => {
    expect(authorNameFor(null, "old-project-name")).toBe("old-project-name")
    expect(authorNameFor(undefined, undefined)).toBe("local")
  })
})
