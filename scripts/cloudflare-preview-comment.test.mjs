import { test } from "node:test"
import assert from "node:assert/strict"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { appCredentials, appJwt, commentOnPreview } from "./cloudflare-preview-comment.mjs"
import { workersBuildPreviewAlias } from "./cloudflare-pr-preview.mjs"
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pem = privateKey.export({ type: "pkcs1", format: "pem" })
const APP_ID = 4911786
const env = {
  WORKERS_CI: "1", WORKERS_CI_BRANCH: "feature/qa", WORKERS_CI_COMMIT_SHA: "a".repeat(40),
  PREVIEW_GITHUB_APP_ID: String(APP_ID), PREVIEW_GITHUB_APP_INSTALLATION_ID: "160934738",
  PREVIEW_GITHUB_APP_PRIVATE_KEY: Buffer.from(pem).toString("base64"),
}
const INSTALLATION_TOKEN = "ghs_test_installation_token"
const urls = { web: `https://${workersBuildPreviewAlias(env.WORKERS_CI_BRANCH)}-aquilla-web-preview.blue-darkness-7674.workers.dev` }
const pr = { number: 628, state: "open", head: { sha: env.WORKERS_CI_COMMIT_SHA, ref: env.WORKERS_CI_BRANCH, repo: { full_name: "genesis-ai-dev/aquilla" } } }
function harness({ comments = [], current = pr, prs = [pr], error = false } = {}) {
  const calls = [], warnings = [], posted = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (error) throw new Error(pem)
    let value
    if (url.endsWith("/access_tokens")) value = { token: INSTALLATION_TOKEN }
    else if (options.method !== "GET") {
      value = { id: 123, performed_via_github_app: { id: APP_ID }, ...JSON.parse(options.body) }
      posted.push(value)
      comments.splice(0, comments.length, value)
    } else if (url.includes("/comments?")) value = comments
    else if (url.includes("/pulls?")) value = prs
    else value = current
    return { ok: true, json: async () => value }
  }
  return { calls, warnings, posted, options: { env, urls, fetchImpl, warn: (s) => warnings.push(s) } }
}
test("signs a JWT the App's public key verifies, issued by the App id", () => {
  const jwt = appJwt(appCredentials(env), 1_800_000_000)
  const [header, payload, signature] = jwt.split(".")
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" })
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), { iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 300, iss: APP_ID })
  const verifier = createVerify("RSA-SHA256")
  verifier.update(`${header}.${payload}`)
  assert.equal(verifier.verify(publicKey, signature, "base64url"), true)
})
test("accepts a raw PEM as well as base64", () => {
  assert.equal(appCredentials({ ...env, PREVIEW_GITHUB_APP_PRIVATE_KEY: pem }).privateKey, pem.trim())
  assert.equal(appCredentials(env).privateKey, pem)
  assert.equal(appCredentials({ ...env, PREVIEW_GITHUB_APP_PRIVATE_KEY: "not a key" }), null)
  assert.equal(appCredentials({ ...env, PREVIEW_GITHUB_APP_ID: "abc" }), null)
})
test("mints a pull-request-write installation token with the JWT, then uses it for every call", async () => {
  const h = harness()
  await commentOnPreview(h.options)
  const [mint, ...rest] = h.calls
  assert.equal(mint.url, "https://api.github.com/app/installations/160934738/access_tokens")
  assert.equal(mint.options.method, "POST")
  assert.deepEqual(JSON.parse(mint.options.body), { permissions: { pull_requests: "write" } })
  assert.match(mint.options.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  assert.ok(rest.length > 0)
  for (const call of rest) assert.equal(call.options.headers.Authorization, `Bearer ${INSTALLATION_TOKEN}`)
  assert.ok(!rest.some((call) => call.url.endsWith("/user")))
})
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
test("does not edit a marker comment another App or a person posted", async () => {
  for (const performed_via_github_app of [null, { id: 999 }]) {
    const h = harness({ comments: [{ id: 99, performed_via_github_app, body: "<!-- aquilla-qa-preview -->" }] })
    await commentOnPreview(h.options)
    assert.equal(h.calls.at(-1).options.method, "POST")
  }
})
for (const [name, current] of Object.entries({ stale: { ...pr, head: { ...pr.head, sha: "b".repeat(40) } }, closed: { ...pr, state: "closed" }, fork: { ...pr, head: { ...pr.head, repo: { full_name: "someone/aquilla" } } } })) {
  test(`skips ${name} PR after rechecking its head`, async () => {
    const h = harness({ current })
    await commentOnPreview(h.options)
    assert.equal(h.posted.length, 0)
  })
}
test("no open PR is a quiet no-op after minting the token", async () => {
  const h = harness({ prs: [] })
  await commentOnPreview(h.options)
  assert.equal(h.calls.length, 2)
  assert.equal(h.warnings.length, 0)
})
test("missing App credentials perform no network calls", async () => {
  for (const missing of ["PREVIEW_GITHUB_APP_ID", "PREVIEW_GITHUB_APP_INSTALLATION_ID", "PREVIEW_GITHUB_APP_PRIVATE_KEY"]) {
    const h = harness()
    await commentOnPreview({ ...h.options, env: { ...env, [missing]: "" } })
    assert.equal(h.calls.length, 0)
    assert.equal(h.warnings.length, 1)
  }
})
test("API errors warn without leaking the key or failing deployment", async () => {
  const h = harness({ error: true })
  await commentOnPreview(h.options)
  assert.equal(h.warnings.length, 1)
  assert.ok(!h.warnings[0].includes("BEGIN"))
})
test("rejects unexpected URLs before any GitHub call", async () => {
  const h = harness()
  await commentOnPreview({ ...h.options, urls: { web: "https://example.com" } })
  assert.equal(h.calls.length, 0)
  assert.equal(h.warnings.length, 1)
})
