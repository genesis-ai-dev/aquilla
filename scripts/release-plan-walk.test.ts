import { describe, expect, it } from "vitest"
import { fillWalks, isTrustedWalkAuthor, lookupPr, lookupWalk, normalizeVerdict, parseWalkComment, walkOf, walkTrustedLogins } from "./release-plan-walk.mjs"

const HEAD_SHA = "a".repeat(40)
const OTHER_SHA = "b".repeat(40)
const MERGE_SHA = "c".repeat(40)

function walkComment(prNumber: number, sha: string, verdict: string) {
  return `## Bot walk — PR ${prNumber} @ ${sha}\n\n**${verdict}** · walk 4/4 · replays 9/9 · https://preview · as translator`
}

describe("parseWalkComment", () => {
  it("parses PR number, head sha, and verdict from a real comment shape", () => {
    expect(parseWalkComment(walkComment(771, HEAD_SHA, "PASS"))).toEqual({
      prNumber: 771,
      sha: HEAD_SHA,
      verdict: "PASS",
    })
  })

  it("accepts the abbreviated, backticked, and re-walk heading shapes the bot also posts", () => {
    const short = HEAD_SHA.slice(0, 7)
    for (const heading of [
      `## Bot walk — PR 771 @ ${short}`,
      `## Bot walk — PR 771 @ \`${HEAD_SHA}\``,
      `## Bot walk — PR 771 @ \`${short}\` (claim 2 rewalk)`,
      `## Bot walk — PR #771 @ ${short} (rewalk after Manager fixture)`,
    ]) {
      expect(parseWalkComment(`${heading}\n\n**PASS** · walk 4/4`)).toEqual({
        prNumber: 771,
        sha: heading.includes(HEAD_SHA) ? HEAD_SHA : short,
        verdict: "PASS",
      })
    }
  })

  it("returns null for a heading with no sha or one too short to identify a commit", () => {
    expect(parseWalkComment("## Bot walk — PR 771\n\n**PASS**")).toBeNull()
    expect(parseWalkComment("## Bot walk — PR 771 @ aaaaaa\n\n**PASS**")).toBeNull()
  })

  it("returns null for a comment with no walk heading", () => {
    expect(parseWalkComment("Looks good to me!")).toBeNull()
  })

  it("returns null when the heading has no matching verdict line", () => {
    expect(parseWalkComment(`## Bot walk — PR 1 @ ${HEAD_SHA}\n\nStill running…`)).toBeNull()
  })

  it("returns null for a non-string body", () => {
    expect(parseWalkComment(undefined)).toBeNull()
    expect(parseWalkComment(null)).toBeNull()
  })
})

// The shapes aquilla-bot has posted since 2026-11-06, copied from merged
// PRs. None carries the "## Bot walk — PR" heading, and for six days every
// one of them read as no walk at all.
describe("parseWalkComment, marker comments", () => {
  const short = HEAD_SHA.slice(0, 8)

  it("reads the sha off the marker and the verdict off the line after it", () => {
    const body = `<!-- aquilla-qa-walk ${HEAD_SHA} -->\n**PASS** · claim walks 4/4 · replays: none (no journey slug for this surface)\n\nHEAD \`${HEAD_SHA}\` · preview MATCH`
    expect(parseWalkComment(body)).toEqual({ prNumber: null, sha: HEAD_SHA, verdict: "PASS" })
    expect(parseWalkComment(`<!-- aquilla-qa-walk ${HEAD_SHA} -->\n**FAIL** · claim walks 2/3`)?.verdict).toBe("FAIL")
  })

  it("reads the QA walk heading under a marker for the PR number", () => {
    const body = `<!-- aquilla-qa-walk ${HEAD_SHA} -->\n## QA walk — #1960 @ ${short}\n\n**PASS** · claim walks 2/2 · replays: none`
    expect(parseWalkComment(body)).toEqual({ prNumber: 1960, sha: HEAD_SHA, verdict: "PASS" })
  })

  it("accepts the sha= marker, and a bare marker when the heading names the sha", () => {
    expect(parseWalkComment(`<!-- aquilla-qa-walk sha=${HEAD_SHA} -->\n**PASS** · claim walks 1/1`)?.sha).toBe(HEAD_SHA)
    expect(parseWalkComment(`<!-- aquilla-qa-walk -->\n## QA walk — #1971 @ ${short}\n\n**PASS** · claim walks 4/4`)).toEqual({
      prNumber: 1971,
      sha: short,
      verdict: "PASS",
    })
  })

  it("reads the QA walk heading with no marker at all", () => {
    expect(parseWalkComment(`## QA walk — #1981 @ ${short}\n\n**PASS** · claim walks 3/3`)).toEqual({ prNumber: 1981, sha: short, verdict: "PASS" })
  })

  it("returns null for a bare marker with no heading: nothing names a commit", () => {
    expect(parseWalkComment("<!-- aquilla-qa-walk -->\n**PASS** · claim walks 1/1")).toBeNull()
  })

  it("returns null when the marker and the heading name different commits", () => {
    expect(parseWalkComment(`<!-- aquilla-qa-walk ${HEAD_SHA} -->\n## QA walk — #1 @ ${OTHER_SHA.slice(0, 8)}\n\n**PASS**`)).toBeNull()
  })

  it("returns null when the line under the marker is not a status line", () => {
    const body = `<!-- aquilla-qa-walk sha=${HEAD_SHA} -->\n### Bot walk · #1957 @ ${short} · **PASS (component level only)**\nClaim (PR words): the control is a button`
    expect(parseWalkComment(body)).toBeNull()
  })

  it("does not read a status line with neither marker nor heading, even one naming the sha", () => {
    expect(parseWalkComment(`**PASS** · claim walks 2/6 · 4 NOT CHECKED\n\nHEAD \`${HEAD_SHA}\``)).toBeNull()
  })
})

describe("parseWalkComment, qualified PASS", () => {
  it("captures a qualifier inside the bold or right after it", () => {
    const inside = `<!-- aquilla-qa-walk ${HEAD_SHA} -->\n## QA walk — #1973 @ ${HEAD_SHA.slice(0, 8)}\n\n**PASS (test level only)** · claim walks 3/3 · replays: none`
    expect(parseWalkComment(inside)).toEqual({ prNumber: 1973, sha: HEAD_SHA, verdict: "PASS", qualifier: "test level only" })
    const after = `<!-- aquilla-qa-walk ${HEAD_SHA} -->\n**PASS** (test level only) · claim walks 3/3 walked on first pass`
    expect(parseWalkComment(after)?.qualifier).toBe("test level only")
    expect(parseWalkComment(`## Bot walk — PR 5 @ ${HEAD_SHA}\n\n**PASS (CI + code read only)** · claim walks 2/4`)?.qualifier).toBe("CI + code read only")
  })

  it("leaves a parenthesis later on the status line alone", () => {
    const parsed = parseWalkComment(`## Bot walk — PR 1838 @ ${HEAD_SHA}\n\n**PASS** · claim walks 6/6 (walkable surface only) · replays 3/3`)
    expect(parsed).toEqual({ prNumber: 1838, sha: HEAD_SHA, verdict: "PASS" })
  })

  it("still does not read a qualified verdict other than PASS", () => {
    expect(parseWalkComment(`## Bot walk — PR 1 @ ${HEAD_SHA}\n\n**NOT CHECKED (scripts only)** · no UI`)).toBeNull()
    expect(parseWalkComment(`## Bot walk — PR 1 @ ${HEAD_SHA}\n\n**FAIL (claim 2)** · 1/2`)).toBeNull()
  })
})

describe("walkOf", () => {
  it("is partial for a qualified PASS and the normalized verdict otherwise", () => {
    expect(walkOf({ prNumber: 1, sha: HEAD_SHA, verdict: "PASS", qualifier: "test level only" })).toBe("partial")
    expect(walkOf({ prNumber: 1, sha: HEAD_SHA, verdict: "PASS" })).toBe("PASS")
    expect(walkOf({ prNumber: null, sha: HEAD_SHA, verdict: "BLOCKED" })).toBe("fail")
    expect(walkOf({ prNumber: null, sha: HEAD_SHA, verdict: "NOT CHECKED" })).toBe("none")
  })
})

describe("normalizeVerdict", () => {
  it("keeps PASS as PASS", () => {
    expect(normalizeVerdict("PASS")).toBe("PASS")
  })

  it("reads NOT CHECKED as none, not a hold", () => {
    expect(normalizeVerdict("NOT CHECKED")).toBe("none")
  })

  it("reads FAIL, FLAKY, and BLOCKED all as fail", () => {
    expect(normalizeVerdict("FAIL")).toBe("fail")
    expect(normalizeVerdict("FLAKY")).toBe("fail")
    expect(normalizeVerdict("BLOCKED")).toBe("fail")
  })
})

interface AssociatedPr {
  number: number
  head: { sha: string }
  merge_commit_sha: string
  labels?: { name: string }[]
}

interface FakeComment {
  body: string
  author_association?: string
  user?: { login: string }
}

function fakeGitHub({
  associatedPrs = [],
  comments = [],
  checkRuns = [],
}: { associatedPrs?: AssociatedPr[]; comments?: FakeComment[]; checkRuns?: Array<{ name: string; conclusion: string | null; app?: { slug: string } }> } = {}) {
  const calls: string[] = []
  const fetchImpl = async (url: string) => {
    calls.push(url)
    if (url.includes("/pulls")) return { ok: true, json: async () => associatedPrs }
    // An organization member wrote the comment unless a case says otherwise.
    if (url.includes("/comments")) return { ok: true, json: async () => comments.map((comment) => ({ author_association: "MEMBER", ...comment })) }
    if (url.includes("/check-runs")) {
      // GitHub Actions is the producer unless a case says otherwise.
      return { ok: true, json: async () => ({ check_runs: checkRuns.map((run) => ({ app: { slug: "github-actions" }, ...run })) }) }
    }
    return { ok: false, status: 404, json: async () => null }
  }
  return { fetchImpl, calls }
}

describe("lookupWalk", () => {
  it("matches the PR's own head sha, not the dev merge commit", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [{ body: walkComment(771, HEAD_SHA, "PASS") }],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe("PASS")
  })

  it("ignores a stale comment whose sha predates a later push", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [{ body: walkComment(771, OTHER_SHA, "PASS") }],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe("unknown")
  })

  it("matches an abbreviated sha against the PR's full head sha", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [{ body: walkComment(771, `\`${HEAD_SHA.slice(0, 8)}\``, "PASS") }],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe("PASS")
  })

  it("lets the newest walk of the head sha win over an earlier one", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [
        { body: walkComment(771, HEAD_SHA, "PASS") },
        { body: walkComment(771, `${HEAD_SHA.slice(0, 7)} (rewalk)`, "FAIL") },
      ],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe("fail")
  })

  it("normalizes FLAKY through the same path as a direct verdict check", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [{ body: walkComment(771, HEAD_SHA, "FLAKY") }],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe("fail")
  })

  it("reads a real NOT CHECKED comment (scripts-only diff) as none, not unknown", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 797, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [
        {
          body: `## Bot walk — PR 797 @ ${HEAD_SHA}\n\n**NOT CHECKED** · SPA skip (scripts-only) · claim walks: none · replays: none · base \`kieran/release-planner-slices\` (not \`dev\`) · as qa-bot`,
        },
      ],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe("none")
  })

  it("reads a marker comment against the head sha, with no PR number to match", async () => {
    const pass = fakeGitHub({
      associatedPrs: [{ number: 1887, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [{ body: `<!-- aquilla-qa-walk ${HEAD_SHA} -->\n**PASS** · claim walks 4/4 · replays: none` }],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl: pass.fetchImpl })).toBe("PASS")
    const stale = fakeGitHub({
      associatedPrs: [{ number: 1887, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [{ body: `<!-- aquilla-qa-walk ${OTHER_SHA} -->\n**PASS** · claim walks 4/4` }],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl: stale.fetchImpl })).toBe("unknown")
  })

  it("ignores a QA walk heading that names another PR", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [{ body: `<!-- aquilla-qa-walk ${HEAD_SHA} -->\n## QA walk — #770 @ ${HEAD_SHA.slice(0, 8)}\n\n**PASS** · claim walks 1/1` }],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe("unknown")
  })

  it("lets a marker FAIL replace an earlier heading PASS on the same head", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [{ body: walkComment(771, HEAD_SHA, "PASS") }, { body: `<!-- aquilla-qa-walk ${HEAD_SHA} -->\n**FAIL** · claim walks 1/2` }],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe("fail")
  })

  // "PASS (test level only)" is the bot passing what it ran without opening
  // a preview. It must never ship a PR on its own, and never change what a
  // real walk of the same commit already said.
  it("reads a qualified PASS as partial, which is not a PASS", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 1973, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [{ body: `<!-- aquilla-qa-walk ${HEAD_SHA} -->\n## QA walk — #1973 @ ${HEAD_SHA.slice(0, 8)}\n\n**PASS (test level only)** · claim walks 3/3` }],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe("partial")
  })

  it("keeps a plain verdict on the head over a qualified PASS, whichever came first", async () => {
    const qualified = { body: `<!-- aquilla-qa-walk ${HEAD_SHA} -->\n**PASS (test level only)** · claim walks 3/3` }
    const cases: Array<[FakeComment[], string]> = [
      [[{ body: walkComment(771, HEAD_SHA, "PASS") }, qualified], "PASS"],
      [[{ body: walkComment(771, HEAD_SHA, "FAIL") }, qualified], "fail"],
      [[qualified, { body: walkComment(771, HEAD_SHA, "PASS") }], "PASS"],
      [[qualified, { body: walkComment(771, HEAD_SHA, "FAIL") }], "fail"],
    ]
    for (const [comments, walk] of cases) {
      const { fetchImpl } = fakeGitHub({ associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }], comments })
      expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe(walk)
    }
  })

  // Anyone with a GitHub account can comment on a PR in a public repository.
  // A walk decides whether a merged PR rides the hourly production line, so
  // only someone with standing in the repository may post one.
  it("ignores a walk from an author with no standing in the repository, PASS or FAIL", async () => {
    const pr = { number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }
    const stranger = (verdict: string, author_association = "NONE") => ({ body: `<!-- aquilla-qa-walk ${HEAD_SHA} -->\n**${verdict}** · claim walks 1/1`, author_association })
    const cases: Array<[FakeComment[], string]> = [
      [[stranger("PASS")], "unknown"],
      [[stranger("PASS", "CONTRIBUTOR")], "unknown"],
      [[stranger("PASS", "FIRST_TIME_CONTRIBUTOR")], "unknown"],
      [[{ body: walkComment(771, HEAD_SHA, "FAIL") }, stranger("PASS")], "fail"],
      [[{ body: walkComment(771, HEAD_SHA, "PASS") }, stranger("FAIL")], "PASS"],
      [[{ body: walkComment(771, HEAD_SHA, "PASS"), author_association: "COLLABORATOR" }], "PASS"],
      [[{ body: walkComment(771, HEAD_SHA, "PASS"), author_association: "OWNER" }], "PASS"],
    ]
    for (const [comments, walk] of cases) {
      const { fetchImpl } = fakeGitHub({ associatedPrs: [pr], comments })
      expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl, trustedLogins: [] })).toBe(walk)
    }
  })

  it("reads a walk from a login named in WALK_TRUSTED_LOGINS whatever its association", async () => {
    const comments = [{ body: walkComment(771, HEAD_SHA, "PASS"), author_association: "NONE", user: { login: "qa-app[bot]" } }]
    const pr = { number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }
    const listed = fakeGitHub({ associatedPrs: [pr], comments })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl: listed.fetchImpl, trustedLogins: ["qa-app[bot]"] })).toBe("PASS")
    const unlisted = fakeGitHub({ associatedPrs: [pr], comments })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl: unlisted.fetchImpl, trustedLogins: ["someone-else"] })).toBe("unknown")
    expect(walkTrustedLogins({ WALK_TRUSTED_LOGINS: "a, b[bot]" })).toEqual(["a", "b[bot]"])
    expect(walkTrustedLogins({})).toEqual([])
    expect(isTrustedWalkAuthor({ user: { login: "a" } }, [])).toBe(false)
    expect(isTrustedWalkAuthor(null, ["a"])).toBe(false)
  })

  it("returns unknown when no PR is associated with the commit", async () => {
    const { fetchImpl } = fakeGitHub({ associatedPrs: [] })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe("unknown")
  })

  it("returns unknown when no comment matches", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [{ body: "unrelated comment" }],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe("unknown")
  })

  it("prefers the PR whose merge_commit_sha matches over the first returned", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [
        { number: 1, head: { sha: OTHER_SHA }, merge_commit_sha: "wrong".padEnd(40, "0") },
        { number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA },
      ],
      comments: [{ body: walkComment(771, HEAD_SHA, "PASS") }],
    })
    expect(await lookupWalk({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toBe("PASS")
  })
})

describe("lookupPr", () => {
  it("reads the release:approved label off the same /pulls response", async () => {
    const { fetchImpl, calls } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA, labels: [{ name: "risk:auth" }, { name: "release:approved" }] }],
      comments: [{ body: walkComment(771, HEAD_SHA, "FAIL") }],
    })
    expect(await lookupPr({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toEqual({ walk: "fail", approved: true, gates: [] })
    expect(calls.filter((url) => url.includes("/pulls"))).toHaveLength(1)
  })

  it("is not approved without the label, and not approved when no PR resolves", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA, labels: [{ name: "risk:auth" }] }],
    })
    expect(await lookupPr({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toEqual({ walk: "unknown", approved: false, gates: [] })
    expect(await lookupPr({ mergeSha: MERGE_SHA, token: "t", fetchImpl: fakeGitHub().fetchImpl })).toEqual({ walk: "unknown", approved: false, gates: [] })
  })

  // The replay gate runs on the PR head; a green run there is what lets an
  // events PR skip the person. Newest run per name wins, so a later failed
  // re-run cancels an earlier pass, and any other check name is ignored.
  it("reads passed gate areas off the head sha's check runs, newest run per name", async () => {
    const { fetchImpl, calls } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA, labels: [{ name: "risk:events" }] }],
      checkRuns: [
        { name: "release-verify", conclusion: "success" },
        { name: "replay-gate", conclusion: "success" },
        { name: "replay-gate", conclusion: "failure" },
      ],
    })
    expect(await lookupPr({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).toEqual({ walk: "unknown", approved: false, gates: ["events"] })
    expect(calls.find((url) => url.includes("/check-runs"))).toContain(`/commits/${HEAD_SHA}/check-runs`)
  })

  it("does not pass a gate posted by anything but GitHub Actions, even when it says success", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      checkRuns: [{ name: "replay-gate", conclusion: "success", app: { slug: "some-other-app" } }],
    })
    expect((await lookupPr({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).gates).toEqual([])
  })

  it("does not pass a gate whose newest run failed or is still running", async () => {
    for (const conclusion of ["failure", null]) {
      const { fetchImpl } = fakeGitHub({
        associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
        checkRuns: [{ name: "replay-gate", conclusion }, { name: "replay-gate", conclusion: "success" }],
      })
      expect((await lookupPr({ mergeSha: MERGE_SHA, token: "t", fetchImpl })).gates).toEqual([])
    }
  })
})

describe("fillWalks", () => {
  it("keeps a docs-only PR at none but still reads its approval", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 2, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA, labels: [{ name: "release:approved" }] }],
    })
    const filled = await fillWalks([{ number: 2, sha: MERGE_SHA, walk: "none" }], { token: "t", fetchImpl })
    expect(filled[0]).toEqual({ number: 2, sha: MERGE_SHA, walk: "none", approved: true, gates: [] })
  })

  it("leaves none and already-resolved PRs untouched, and fills unknown ones", async () => {
    const { fetchImpl } = fakeGitHub({
      associatedPrs: [{ number: 771, head: { sha: HEAD_SHA }, merge_commit_sha: MERGE_SHA }],
      comments: [{ body: walkComment(771, HEAD_SHA, "PASS") }],
    })
    const prs = [
      { number: 1, sha: MERGE_SHA, walk: "unknown" },
      { number: 2, sha: "z".repeat(40), walk: "none" },
    ]
    const filled = await fillWalks(prs, { token: "t", fetchImpl })
    expect(filled[0].walk).toBe("PASS")
    expect(filled[1].walk).toBe("none")
  })

  it("leaves a PR unknown when its own lookup throws, without affecting the others", async () => {
    let call = 0
    const fetchImpl = async (url: string) => {
      call++
      if (url.includes(MERGE_SHA)) throw new Error("network error")
      if (url.includes("/pulls")) return { ok: true, json: async () => [{ number: 2, head: { sha: HEAD_SHA } }] }
      return { ok: true, json: async () => [{ body: walkComment(2, HEAD_SHA, "PASS"), author_association: "MEMBER" }] }
    }
    const prs = [
      { number: 1, sha: MERGE_SHA, walk: "unknown" },
      { number: 2, sha: "d".repeat(40), walk: "unknown" },
    ]
    const filled = await fillWalks(prs, { token: "t", fetchImpl })
    expect(filled[0].walk).toBe("unknown")
    expect(filled[1].walk).toBe("PASS")
    expect(call).toBeGreaterThan(1)
  })
})
