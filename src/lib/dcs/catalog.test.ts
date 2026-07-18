import { describe, it, expect, vi } from "vitest"
import { DcsClient, DEFAULT_DCS_BASE, DEFAULT_DCS_RAW_BASE } from "./catalog"

/** Build a fetch stub that records the URL it was called with and returns the
 *  given JSON (or text). Asserting on `calls` verifies the client hit the right
 *  endpoint — no real network. */
function stubFetch(handler: (url: string) => { json?: unknown; text?: string; ok?: boolean; status?: number }) {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    calls.push(url)
    const r = handler(url)
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json,
      text: async () => r.text ?? "",
    } as Response
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

describe("DcsClient.searchCatalog", () => {
  it("GETs /catalog/search with query params and normalizes rows to camelCase", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      json: {
        data: [
          {
            name: "en_ult",
            owner: "unfoldingWord",
            full_name: "unfoldingWord/en_ult",
            subject: "Aligned Bible",
            content_format: "usfm",
            flavor_type: "scripture",
            branch_or_tag_name: "v89",
            ref_type: "tag",
            commit_sha: "84c73ba0",
            released: "2026-06-23T22:01:02Z",
            zipball_url: "https://git.door43.org/z.zip",
            metadata_url: "https://git.door43.org/manifest.yaml",
            language: "en",
            language_title: "English",
            language_direction: "ltr",
          },
        ],
      },
    }))
    const client = new DcsClient({ fetchImpl })
    const rows = await client.searchCatalog({ lang: "en", subject: "Aligned Bible" })

    expect(calls[0]).toContain(`${DEFAULT_DCS_BASE}/catalog/search?`)
    expect(calls[0]).toContain("lang=en")
    expect(calls[0]).toContain("subject=Aligned+Bible")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: "en_ult",
      fullName: "unfoldingWord/en_ult",
      contentFormat: "usfm",
      ref: "v89",
      refType: "tag",
      commitSha: "84c73ba0",
      metadataUrl: "https://git.door43.org/manifest.yaml",
      language: "en",
    })
  })
})

describe("DcsClient.getCatalogEntry", () => {
  it("GETs the entry endpoint and maps the [sic] tarbar_url + metadata_url", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      json: {
        name: "en_ult",
        owner: "unfoldingWord",
        full_name: "unfoldingWord/en_ult",
        subject: "Aligned Bible",
        content_format: "usfm",
        branch_or_tag_name: "v89",
        ref_type: "tag",
        commit_sha: "84c73ba0deadbeef",
        released: "2026-06-23T22:01:02Z",
        // DCS spells this "tarbar_url" (sic) — the archive URL.
        tarbar_url: "https://git.door43.org/uW/en_ult/archive/v89.tar.gz",
        metadata_url: "https://git.door43.org/uW/en_ult/raw/tag/v89/manifest.yaml",
        language: "en",
      },
    }))
    const client = new DcsClient({ fetchImpl })
    const entry = await client.getCatalogEntry("unfoldingWord", "en_ult", "v89")

    expect(calls[0]).toBe(`${DEFAULT_DCS_BASE}/catalog/entry/unfoldingWord/en_ult/v89`)
    expect(entry.zipballUrl).toBe("https://git.door43.org/uW/en_ult/archive/v89.tar.gz")
    expect(entry.metadataUrl).toBe(
      "https://git.door43.org/uW/en_ult/raw/tag/v89/manifest.yaml",
    )
    expect(entry.commitSha).toBe("84c73ba0deadbeef")
  })
})

describe("DcsClient.compareRefs — the Gitea union quirk (spec §6)", () => {
  it("computes changed files as the UNIQUE UNION of .commits[].files[].filename, ignoring the (empty) top-level .files", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      json: {
        total_commits: 3,
        // Top-level files is EMPTY on DCS's Gitea — must NOT be read.
        files: [],
        commits: [
          { files: [{ filename: "57-TIT.usfm" }, { filename: "58-PHM.usfm" }] },
          { files: [{ filename: "57-TIT.usfm" }] }, // duplicate — de-duped
          { files: [{ filename: "manifest.yaml" }] },
        ],
      },
    }))
    const client = new DcsClient({ fetchImpl })
    const res = await client.compareRefs("unfoldingWord", "en_ult", "v88", "v89")

    expect(calls[0]).toBe(
      `${DEFAULT_DCS_BASE}/repos/unfoldingWord/en_ult/compare/v88...v89`,
    )
    expect(res.totalCommits).toBe(3)
    expect(res.changedFiles.sort()).toEqual(
      ["57-TIT.usfm", "58-PHM.usfm", "manifest.yaml"].sort(),
    )
    // The empty top-level .files must not shadow the per-commit union.
    expect(res.changedFiles).toContain("57-TIT.usfm")
  })

  it("returns an empty changed-file set when there are no commits", async () => {
    const { fetchImpl } = stubFetch(() => ({
      json: { total_commits: 0, files: [], commits: [] },
    }))
    const client = new DcsClient({ fetchImpl })
    const res = await client.compareRefs("uW", "en_ult", "v89", "v89")
    expect(res.changedFiles).toEqual([])
  })
})

describe("DcsClient.compareRefs — throttled/empty-body retry (rate-limit guard)", () => {
  it("retries a malformed body (no numeric total_commits) then THROWS after exhausting retries", async () => {
    // DCS under throttle returns HTTP 200 with an empty/malformed body: no
    // total_commits, no commits. This is indistinguishable from a real
    // no-change ONLY if we ignore total_commits — so it must NOT resolve to an
    // empty delta, it must throw.
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      return {
        ok: true,
        status: 200,
        json: async () => ({}), // throttled: no total_commits
        text: async () => "",
      } as Response
    }) as unknown as typeof fetch

    // retries=2 → initial attempt + 2 retries = 3 fetches total, then throw.
    const client = new DcsClient({ fetchImpl, compareRetries: 2, retryBaseMs: 0 })
    await expect(client.compareRefs("uW", "en_ult", "v88", "v89")).rejects.toThrow(
      /no data after 2 retries|rate-limited/,
    )
    expect(calls).toBe(3)
  })

  it("recovers: a malformed body once, then a good body → returns the union after retry", async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      const body =
        calls === 1
          ? {} // throttled first
          : {
              total_commits: 2,
              files: [], // top-level empty (Gitea quirk)
              commits: [
                { files: [{ filename: "57-TIT.usfm" }] },
                { files: [{ filename: "manifest.yaml" }] },
              ],
            }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => "",
      } as Response
    }) as unknown as typeof fetch

    const client = new DcsClient({ fetchImpl, compareRetries: 3, retryBaseMs: 0 })
    const res = await client.compareRefs("uW", "en_ult", "v88", "v89")
    expect(calls).toBe(2) // one throttle + one good
    expect(res.totalCommits).toBe(2)
    expect(res.changedFiles.sort()).toEqual(["57-TIT.usfm", "manifest.yaml"].sort())
  })

  it("does NOT retry a genuine no-change (numeric total_commits: 0) — returns empty immediately", async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      return {
        ok: true,
        status: 200,
        json: async () => ({ total_commits: 0, files: [], commits: [] }),
        text: async () => "",
      } as Response
    }) as unknown as typeof fetch

    const client = new DcsClient({ fetchImpl, compareRetries: 3, retryBaseMs: 0 })
    const res = await client.compareRefs("uW", "en_ult", "v89", "v89")
    expect(calls).toBe(1) // numeric 0 is a real answer, not a throttle
    expect(res.totalCommits).toBe(0)
    expect(res.changedFiles).toEqual([])
  })

  it("does not actually sleep between retries when a zero-delay sleep is injected", async () => {
    let calls = 0
    let slept = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      return {
        ok: true,
        status: 200,
        json: async () => (calls < 3 ? {} : { total_commits: 0, commits: [] }),
        text: async () => "",
      } as Response
    }) as unknown as typeof fetch

    const client = new DcsClient({
      fetchImpl,
      compareRetries: 5,
      retryBaseMs: 999_999, // would hang the suite if the real timer ran
      sleep: async () => { slept++ },
    })
    const res = await client.compareRefs("uW", "en_ult", "v88", "v89")
    expect(res.totalCommits).toBe(0)
    expect(calls).toBe(3) // two throttles, then good
    expect(slept).toBe(2) // slept once per retry, via the injected no-op timer
  })
})

describe("DcsClient.getTree", () => {
  it("GETs the recursive tree and returns only blob paths", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      json: {
        tree: [
          { path: "57-TIT.usfm", type: "blob" },
          { path: "58-PHM.usfm", type: "blob" },
          { path: "content", type: "tree" }, // directories excluded
        ],
      },
    }))
    const client = new DcsClient({ fetchImpl })
    const paths = await client.getTree("unfoldingWord", "en_ult", "v89")

    expect(calls[0]).toContain(
      `${DEFAULT_DCS_BASE}/repos/unfoldingWord/en_ult/git/trees/v89?`,
    )
    expect(calls[0]).toContain("recursive=1")
    expect(paths).toEqual(["57-TIT.usfm", "58-PHM.usfm"])
  })
})

describe("DcsClient.fetchRaw", () => {
  it("uses raw/tag/{ref}/ for tag refs", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ text: "\\id TIT\n\\v 1 ..." }))
    const client = new DcsClient({ fetchImpl })
    const body = await client.fetchRaw("unfoldingWord", "en_ult", "v89", "57-TIT.usfm", "tag")
    expect(calls[0]).toBe(
      `${DEFAULT_DCS_RAW_BASE}/unfoldingWord/en_ult/raw/tag/v89/57-TIT.usfm`,
    )
    expect(body).toContain("\\id TIT")
  })

  it("uses raw/branch/{ref}/ for branch refs", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ text: "x" }))
    const client = new DcsClient({ fetchImpl })
    await client.fetchRaw("unfoldingWord", "en_ult", "master", "57-TIT.usfm", "branch")
    expect(calls[0]).toBe(
      `${DEFAULT_DCS_RAW_BASE}/unfoldingWord/en_ult/raw/branch/master/57-TIT.usfm`,
    )
  })
})

describe("DcsClient error handling", () => {
  it("throws on a non-ok response", async () => {
    const { fetchImpl } = stubFetch(() => ({ ok: false, status: 404, text: "not found" }))
    const client = new DcsClient({ fetchImpl })
    await expect(client.getCatalogEntry("uW", "nope", "v1")).rejects.toThrow(/404/)
  })
})

describe("DcsClient default fetch binding (DEFECT 1 — Illegal invocation guard)", () => {
  it("with NO injected fetchImpl, calls through to the BOUND global fetch", async () => {
    // In a real browser, storing the bare native `fetch` and later calling it as
    // `this.fetchImpl(url)` throws "Illegal invocation" (fetch needs this===window).
    // The client must default to `fetch.bind(globalThis)`. We prove the default
    // path invokes global fetch — and, critically, that what the client stored is
    // NOT the same unbound reference it would fail on. A spy on globalThis.fetch
    // that asserts its own `this` catches a regression to the unbound form.
    const realFetch = globalThis.fetch
    const spy = vi.fn(async function (this: unknown) {
      // A correctly-bound default calls with this === globalThis (or undefined
      // under strict binding), NEVER with this === the DcsClient instance.
      expect(this === undefined || this === globalThis).toBe(true)
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
        text: async () => "",
      } as Response
    })
    // Assign the spy as the global; the client's `fetch.bind(globalThis)` default
    // must resolve to THIS spy (bound), not a stale/unbound reference.
    globalThis.fetch = spy as unknown as typeof fetch
    try {
      const client = new DcsClient() // no fetchImpl → default path
      const rows = await client.searchCatalog({ lang: "en" })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(rows).toEqual([])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe("DcsClient.getLatestRelease (DEFECT 3 — resolve the newest prod release)", () => {
  it("searches owner+repo+stage=prod and returns the entry with the newest released date", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      json: {
        data: [
          {
            name: "en_obs",
            owner: "unfoldingWord",
            full_name: "unfoldingWord/en_obs",
            branch_or_tag_name: "v8",
            commit_sha: "sha-v8",
            released: "2024-01-01T00:00:00Z",
          },
          {
            name: "en_obs",
            owner: "unfoldingWord",
            full_name: "unfoldingWord/en_obs",
            branch_or_tag_name: "v9",
            commit_sha: "sha-v9",
            released: "2026-06-01T00:00:00Z",
          },
        ],
      },
    }))
    const client = new DcsClient({ fetchImpl })
    const latest = await client.getLatestRelease("unfoldingWord", "en_obs")

    // Hit the search endpoint scoped to owner+repo+prod (NOT the pinned ref).
    expect(calls[0]).toContain(`${DEFAULT_DCS_BASE}/catalog/search?`)
    expect(calls[0]).toContain("owner=unfoldingWord")
    expect(calls[0]).toContain("repo=en_obs")
    expect(calls[0]).toContain("stage=prod")
    // Newest release wins even when the API returns them out of order.
    expect(latest?.ref).toBe("v9")
    expect(latest?.commitSha).toBe("sha-v9")
  })

  it("returns null when the repo has no prod release", async () => {
    const { fetchImpl } = stubFetch(() => ({ json: { data: [] } }))
    const client = new DcsClient({ fetchImpl })
    expect(await client.getLatestRelease("uW", "nope")).toBeNull()
  })
})
