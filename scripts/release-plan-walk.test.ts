import { describe, expect, it } from "vitest"
import { fillWalks, lookupWalk, normalizeVerdict, parseWalkComment } from "./release-plan-walk.mjs"

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
}

interface FakeComment {
  body: string
}

function fakeGitHub({
  associatedPrs = [],
  comments = [],
}: { associatedPrs?: AssociatedPr[]; comments?: FakeComment[] } = {}) {
  const calls: string[] = []
  const fetchImpl = async (url: string) => {
    calls.push(url)
    if (url.includes("/pulls")) return { ok: true, json: async () => associatedPrs }
    if (url.includes("/comments")) return { ok: true, json: async () => comments }
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

describe("fillWalks", () => {
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
      return { ok: true, json: async () => [{ body: walkComment(2, HEAD_SHA, "PASS") }] }
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
