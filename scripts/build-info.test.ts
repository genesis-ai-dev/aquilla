import { describe, expect, it } from "vitest"
import { UNKNOWN, resolveBuildBranch, resolveBuildDate, resolveBuildSha } from "./build-info"

describe("resolveBuildBranch", () => {
  it("prefers the Cloudflare Workers Builds branch over git", () => {
    expect(resolveBuildBranch({ WORKERS_CI_BRANCH: "main" }, "HEAD")).toBe("main")
  })

  it("never reports a detached HEAD as the branch name (AQU-1023)", () => {
    // Workers Builds checks out a detached HEAD; git answers the literal "HEAD".
    expect(resolveBuildBranch({}, "HEAD")).toBe(UNKNOWN)
  })

  it("falls back through the CI env vars in precedence order", () => {
    expect(resolveBuildBranch({ CF_PAGES_BRANCH: "pages-branch" }, "HEAD")).toBe("pages-branch")
    expect(resolveBuildBranch({ GITHUB_HEAD_REF: "pr-branch" }, "HEAD")).toBe("pr-branch")
    expect(resolveBuildBranch({ GITHUB_REF_NAME: "tag-or-branch" }, "HEAD")).toBe("tag-or-branch")
    expect(
      resolveBuildBranch({ WORKERS_CI_BRANCH: "main", GITHUB_REF_NAME: "other" }, "HEAD"),
    ).toBe("main")
  })

  it("uses the local branch when no CI env is present", () => {
    expect(resolveBuildBranch({}, "agent/AQU-1023-version-build-date")).toBe(
      "agent/AQU-1023-version-build-date",
    )
  })

  it("ignores blank and whitespace-only values", () => {
    expect(resolveBuildBranch({ WORKERS_CI_BRANCH: "   " }, "dev")).toBe("dev")
    expect(resolveBuildBranch({}, "")).toBe(UNKNOWN)
  })
})

describe("resolveBuildSha", () => {
  it("shortens the CI commit sha", () => {
    expect(resolveBuildSha({ WORKERS_CI_COMMIT_SHA: "0123456789abcdef" }, "")).toBe("0123456")
  })

  it("falls back to git, then to a placeholder", () => {
    expect(resolveBuildSha({}, "abcdef1234")).toBe("abcdef1")
    expect(resolveBuildSha({}, "")).toBe(UNKNOWN)
  })
})

describe("resolveBuildDate", () => {
  it("uses the commit date when git resolves one", () => {
    expect(resolveBuildDate("2026-08-27T14:23:21+02:00")).toBe("2026-08-27T12:23:21.000Z")
  })

  it("falls back to build time when the commit date is missing or unparseable", () => {
    const now = new Date("2026-09-03T10:00:00.000Z")
    expect(resolveBuildDate("", now)).toBe("2026-09-03T10:00:00.000Z")
    expect(resolveBuildDate("not-a-date", now)).toBe("2026-09-03T10:00:00.000Z")
  })
})
