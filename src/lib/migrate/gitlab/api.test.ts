// Pure-helper tests for the GitLab API layer: X-Next-Page pagination parsing
// (the loop-termination signal — a wrong read means either an infinite loop or
// a truncated project list) and Codex metadata detection (the heuristic that
// decides which GitLab repos are importable Codex projects). The detection
// fixture mirrors the real shape codex-editor writes, verified against an
// on-disk project's metadata.json.

import { afterEach, describe, it, expect, vi } from "vitest"
import { isCodexMetadata, listGroupMembers, parseNextPage } from "./api"

afterEach(() => {
  vi.restoreAllMocks()
})

/** Minimal Headers-like stand-in matching what parseNextPage consumes. */
function headers(map: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null }
}

describe("parseNextPage", () => {
  it("returns the page number when X-Next-Page is a positive integer", () => {
    expect(parseNextPage(headers({ "X-Next-Page": "2" }))).toBe(2)
    expect(parseNextPage(headers({ "X-Next-Page": "17" }))).toBe(17)
  })

  it("is case-insensitive about the header name", () => {
    expect(parseNextPage(headers({ "x-next-page": "3" }))).toBe(3)
  })

  it("returns null when the header is absent — the stop signal", () => {
    expect(parseNextPage(headers({}))).toBeNull()
  })

  it("returns null when the header is blank (GitLab's last-page convention)", () => {
    expect(parseNextPage(headers({ "X-Next-Page": "" }))).toBeNull()
    expect(parseNextPage(headers({ "X-Next-Page": "   " }))).toBeNull()
  })

  it("returns null for non-positive or non-integer values (defensive stop)", () => {
    expect(parseNextPage(headers({ "X-Next-Page": "0" }))).toBeNull()
    expect(parseNextPage(headers({ "X-Next-Page": "-1" }))).toBeNull()
    expect(parseNextPage(headers({ "X-Next-Page": "abc" }))).toBeNull()
    expect(parseNextPage(headers({ "X-Next-Page": "1.5" }))).toBeNull()
  })

  it("works against a real Headers instance", () => {
    const h = new Headers()
    h.set("X-Next-Page", "4")
    expect(parseNextPage(h)).toBe(4)
    const empty = new Headers()
    expect(parseNextPage(empty)).toBeNull()
  })
})

describe("isCodexMetadata", () => {
  it("accepts the real Scripture-Burrito shape codex-editor writes", () => {
    // Trimmed from a real metadata.json on disk.
    const meta = {
      format: "scripture burrito",
      projectName: "E2E Test Project",
      projectId: "e2e-test-project-001",
      meta: { version: "0.0.0", category: "source" },
      languages: [{ tag: "en", refName: "English", projectStatus: "source" }],
    }
    expect(isCodexMetadata(meta)).toBe(true)
  })

  it("accepts a project with an EMPTY projectName (the Chosen case)", () => {
    // The Armenian 'The Chosen' export carries projectName: "" — presence of
    // the string key (plus meta/languages) must still count as Codex.
    const meta = {
      projectName: "",
      meta: { version: "0.0.0" },
      languages: [{ tag: "hy" }],
    }
    expect(isCodexMetadata(meta)).toBe(true)
  })

  it("accepts when only one of projectName/meta/languages is present", () => {
    expect(isCodexMetadata({ projectName: "x" })).toBe(true)
    expect(isCodexMetadata({ meta: {} })).toBe(true)
    expect(isCodexMetadata({ languages: [] })).toBe(true)
  })

  it("rejects unrelated JSON objects (a package.json-ish blob)", () => {
    expect(
      isCodexMetadata({ name: "foo", version: "1.0.0", dependencies: {} }),
    ).toBe(false)
  })

  it("rejects non-objects, arrays, and null", () => {
    expect(isCodexMetadata(null)).toBe(false)
    expect(isCodexMetadata("string")).toBe(false)
    expect(isCodexMetadata(42)).toBe(false)
    expect(isCodexMetadata([{ projectName: "x" }])).toBe(false)
  })

  it("rejects when meta is null or languages is a non-array (shape guard)", () => {
    expect(isCodexMetadata({ meta: null })).toBe(false)
    expect(isCodexMetadata({ languages: "en" })).toBe(false)
    // projectName must be a string, not a number.
    expect(isCodexMetadata({ projectName: 123 })).toBe(false)
  })
})

describe("listGroupMembers", () => {
  it("loads effective members so inherited parent-group access is preserved", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([{ id: 77, username: "cleiton", access_level: 30 }]),
        { status: 200, headers: { "X-Next-Page": "" } },
      ),
    )

    await expect(listGroupMembers({
      gitlabUrl: "https://gitlab.example",
      gitlabToken: "admin-token",
      accessToken: "",
    }, 11)).resolves.toEqual([
      { id: 77, username: "cleiton", access_level: 30 },
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example/api/v4/groups/11/members/all?per_page=100&page=1",
      { headers: { Authorization: "Bearer admin-token" } },
    )
  })
})
