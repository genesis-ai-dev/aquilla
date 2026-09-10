import { test } from "node:test"
import assert from "node:assert/strict"
import { commentOnPreview } from "./cloudflare-preview-comment.mjs"
import { workersBuildPreviewAlias } from "./cloudflare-pr-preview.mjs"
const env = { WORKERS_CI: "1", WORKERS_CI_BRANCH: "feature/qa", WORKERS_CI_COMMIT_SHA: "a".repeat(40), PREVIEW_GITHUB_TOKEN: "test-secret" }
const urls = { web: `https://${workersBuildPreviewAlias(env.WORKERS_CI_BRANCH)}-aquilla-web-preview.blue-darkness-7674.workers.dev` }
const pr = { number: 628, state: "open", head: { sha: env.WORKERS_CI_COMMIT_SHA, ref: env.WORKERS_CI_BRANCH, repo: { full_name: "genesis-ai-dev/aquilla" } } }
function harness({ comments = [], current = pr, prs = [pr], error = false } = {}) {
  const calls = [], warnings = [], posted = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (error) throw new Error(env.PREVIEW_GITHUB_TOKEN)
    let value
    if (options.method !== "GET") {
      value = { id: 123, user: { id: 7 }, ...JSON.parse(options.body) }
      posted.push(value)
      comments.splice(0, comments.length, value)
    } else if (url.endsWith("/user")) value = { id: 7 }
    else if (url.includes("/comments?")) value = comments
    else if (url.includes("/pulls?")) value = prs
    else value = current
    return { ok: true, json: async () => value }
  }
  return { calls, warnings, posted, options: { env, urls, fetchImpl, warn: (s) => warnings.push(s) } }
}
test("posts exact URL/commit, updates own comment, and avoids duplicate unchanged comments", async () => {
  const h = harness()
  await commentOnPreview(h.options)
  assert.equal(h.posted.length, 1)
  assert.ok(h.posted[0].body.includes(urls.web))
  assert.ok(h.posted[0].body.includes(env.WORKERS_CI_COMMIT_SHA))
  assert.equal(h.calls.at(-1).options.method, "POST")
  await commentOnPreview(h.options)
  assert.equal(h.posted.length, 1)
  h.posted[0].body += " old"
  await commentOnPreview(h.options)
  assert.equal(h.calls.at(-1).options.method, "PATCH")
  assert.equal(h.posted.length, 2)
})
test("does not edit another author's marker comment", async () => {
  const h = harness({ comments: [{ id: 99, user: { id: 8 }, body: "<!-- aquilla-qa-preview -->" }] })
  await commentOnPreview(h.options)
  assert.equal(h.calls.at(-1).options.method, "POST")
})
for (const [name, current] of Object.entries({ stale: { ...pr, head: { ...pr.head, sha: "b".repeat(40) } }, closed: { ...pr, state: "closed" }, fork: { ...pr, head: { ...pr.head, repo: { full_name: "someone/aquilla" } } } })) {
  test(`skips ${name} PR after rechecking its head`, async () => {
    const h = harness({ current })
    await commentOnPreview(h.options)
    assert.equal(h.posted.length, 0)
  })
}
test("no open PR is a quiet no-op", async () => {
  const h = harness({ prs: [] })
  await commentOnPreview(h.options)
  assert.equal(h.calls.length, 1)
  assert.equal(h.warnings.length, 0)
})
test("missing token performs no network calls", async () => {
  const h = harness()
  await commentOnPreview({ ...h.options, env: { ...env, PREVIEW_GITHUB_TOKEN: "" } })
  assert.equal(h.calls.length, 0)
  assert.equal(h.warnings.length, 1)
})
test("API errors warn without leaking credentials or failing deployment", async () => {
  const h = harness({ error: true })
  await commentOnPreview(h.options)
  assert.equal(h.warnings.length, 1)
  assert.ok(!h.warnings[0].includes(env.PREVIEW_GITHUB_TOKEN))
})
test("rejects unexpected URLs before GitHub writes", async () => {
  const h = harness()
  await commentOnPreview({ ...h.options, urls: { web: "https://example.com" } })
  assert.equal(h.calls.length, 0)
  assert.equal(h.warnings.length, 1)
})
