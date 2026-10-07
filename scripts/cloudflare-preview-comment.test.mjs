// This file ran under `node:test` until AQU-1273 and so never actually
// executed: the root Vitest project collected it, failed to bundle
// `node:test`, and reported the whole file as a failure with zero tests. It is
// Vitest now, like every other test under scripts/, and runs in the
// "scripts-node" project (see vite.config.ts) — a plain node environment with
// none of the app's browser polyfills, which is the runtime the script it
// covers actually gets from `node scripts/cloudflare-stack-preview.mjs`.
import { test, expect } from "vitest"
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
  expect(JSON.parse(Buffer.from(header, "base64url"))).toStrictEqual({ alg: "RS256", typ: "JWT" })
  expect(JSON.parse(Buffer.from(payload, "base64url"))).toStrictEqual({ iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 300, iss: APP_ID })
  const verifier = createVerify("RSA-SHA256")
  verifier.update(`${header}.${payload}`)
  expect(verifier.verify(publicKey, signature, "base64url")).toBe(true)
})
test("accepts the short variable names the first setup used", () => {
  const short = {
    WORKERS_CI: env.WORKERS_CI, WORKERS_CI_BRANCH: env.WORKERS_CI_BRANCH, WORKERS_CI_COMMIT_SHA: env.WORKERS_CI_COMMIT_SHA,
    PREVIEW_GITHUB_APP_ID: env.PREVIEW_GITHUB_APP_ID, INSTALLATION_ID: "160934738", PRIVATE_KEY: env.PREVIEW_GITHUB_APP_PRIVATE_KEY,
  }
  expect(appCredentials(short)).toStrictEqual({ appId: APP_ID, installationId: 160934738, privateKey: pem })
  expect(appCredentials({ ...short, INSTALLATION_ID: "" }).problems).toStrictEqual(["PREVIEW_GITHUB_APP_INSTALLATION_ID is missing"])
})
test("accepts a raw PEM as well as base64", () => {
  expect(appCredentials({ ...env, PREVIEW_GITHUB_APP_PRIVATE_KEY: pem }).privateKey).toBe(pem.trim())
  expect(appCredentials(env).privateKey).toBe(pem)
  expect(appCredentials({ ...env, PREVIEW_GITHUB_APP_PRIVATE_KEY: "not a key" }).problems).toStrictEqual(["PREVIEW_GITHUB_APP_PRIVATE_KEY is neither a PEM nor base64 of one"])
  expect(appCredentials({ ...env, PREVIEW_GITHUB_APP_ID: "abc", PREVIEW_GITHUB_APP_INSTALLATION_ID: "" }).problems).toStrictEqual(
    ["PREVIEW_GITHUB_APP_ID is not a positive integer", "PREVIEW_GITHUB_APP_INSTALLATION_ID is missing"])
})
test("mints a pull-request-write installation token with the JWT, then uses it for every call", async () => {
  const h = harness()
  await commentOnPreview(h.options)
  const [mint, ...rest] = h.calls
  expect(mint.url).toBe("https://api.github.com/app/installations/160934738/access_tokens")
  expect(mint.options.method).toBe("POST")
  expect(JSON.parse(mint.options.body)).toStrictEqual({ permissions: { pull_requests: "write" } })
  expect(mint.options.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  expect(rest.length > 0).toBeTruthy()
  for (const call of rest) expect(call.options.headers.Authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`)
  expect(!rest.some((call) => call.url.endsWith("/user"))).toBeTruthy()
})
test("posts exact URL/commit, updates own comment, and avoids duplicate unchanged comments", async () => {
  const h = harness()
  await commentOnPreview(h.options)
  expect(h.posted.length).toBe(1)
  expect(h.posted[0].body.includes(urls.web)).toBeTruthy()
  expect(h.posted[0].body.includes(env.WORKERS_CI_COMMIT_SHA)).toBeTruthy()
  expect(h.posted[0].body.includes("This preview build does not run Jev.")).toBeTruthy()
  expect(h.posted[0].body.includes("NOT VERIFIED")).toBeTruthy()
  expect(h.calls.at(-1).options.method).toBe("POST")
  await commentOnPreview(h.options)
  expect(h.posted.length).toBe(1)
  h.posted[0].body += " old"
  await commentOnPreview(h.options)
  expect(h.calls.at(-1).options.method).toBe("PATCH")
  expect(h.posted.length).toBe(2)
})
test("does not edit a marker comment another App or a person posted", async () => {
  for (const performed_via_github_app of [null, { id: 999 }]) {
    const h = harness({ comments: [{ id: 99, performed_via_github_app, body: "<!-- aquilla-qa-preview -->" }] })
    await commentOnPreview(h.options)
    expect(h.calls.at(-1).options.method).toBe("POST")
  }
})
for (const [name, current] of Object.entries({ stale: { ...pr, head: { ...pr.head, sha: "b".repeat(40) } }, closed: { ...pr, state: "closed" }, fork: { ...pr, head: { ...pr.head, repo: { full_name: "someone/aquilla" } } } })) {
  test(`skips ${name} PR after rechecking its head`, async () => {
    const h = harness({ current })
    await commentOnPreview(h.options)
    expect(h.posted.length).toBe(0)
  })
}
test("no open PR is a quiet no-op after minting the token", async () => {
  const h = harness({ prs: [] })
  await commentOnPreview(h.options)
  expect(h.calls.length).toBe(2)
  expect(h.warnings.length).toBe(0)
})
test("missing App credentials perform no network calls and name the variable, never its value", async () => {
  for (const missing of ["PREVIEW_GITHUB_APP_ID", "PREVIEW_GITHUB_APP_INSTALLATION_ID", "PREVIEW_GITHUB_APP_PRIVATE_KEY"]) {
    const h = harness()
    await commentOnPreview({ ...h.options, env: { ...env, [missing]: "" } })
    expect(h.calls.length).toBe(0)
    expect(h.warnings.length).toBe(1)
    expect(h.warnings[0].includes(`${missing} is missing`)).toBeTruthy()
    expect(!h.warnings[0].includes(env.PREVIEW_GITHUB_APP_PRIVATE_KEY.slice(0, 20))).toBeTruthy()
  }
})
test("API errors warn without leaking the key or failing deployment", async () => {
  const h = harness({ error: true })
  await commentOnPreview(h.options)
  expect(h.warnings.length).toBe(1)
  expect(!h.warnings[0].includes("BEGIN")).toBeTruthy()
})
test("rejects unexpected URLs before any GitHub call", async () => {
  const h = harness()
  await commentOnPreview({ ...h.options, urls: { web: "https://example.com" } })
  expect(h.calls.length).toBe(0)
  expect(h.warnings.length).toBe(1)
})
