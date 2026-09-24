// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { workersBuildPreviewAlias as alias } from "./cloudflare-pr-preview.mjs"

// The GitHub fallback signs an App JWT with a real RSA key. The root vitest
// project shims node:crypto for the SPA, so stand in for the two App helpers
// (both already covered by scripts/cloudflare-preview-comment.test.mjs).
vi.mock("./cloudflare-preview-comment.mjs", () => ({
  appCredentials: (env: NodeJS.ProcessEnv) => (env.PREVIEW_GITHUB_APP_ID
    ? { appId: Number(env.PREVIEW_GITHUB_APP_ID), installationId: Number(env.PREVIEW_GITHUB_APP_INSTALLATION_ID), privateKey: "test-key" }
    : { problems: ["PREVIEW_GITHUB_APP_ID is missing"] }),
  appJwt: () => "app-jwt",
}))
import {
  cleanupStalePreviews,
  DEFAULT_IDLE_DAYS,
  liveBranchAliases,
  previewLastActivity,
  selectStalePreviews,
  type CloudflarePreview,
} from "./cloudflare-preview-cleanup.mjs"

const NOW = Date.parse("2026-09-24T15:00:00Z")
const DAY = 86_400_000
const ACCOUNT = "6a80496d1e59948a9cbaa3c643ba81d7"
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/workers/`
const TOKEN = "cf-token-that-must-never-be-logged"

const preview = (name: string, daysAgo: number | null = 1): CloudflarePreview => {
  const stamp = daysAgo === null ? null : new Date(NOW - daysAgo * DAY).toISOString()
  return { id: `id-${name}`, name, deployed_on: stamp, updated_on: stamp, created_on: stamp }
}
const jsonResponse = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
type FetchLike = (url: string, init: RequestInit) => Promise<ReturnType<typeof jsonResponse>>
const asFetch = (impl: FetchLike) => impl as unknown as typeof fetch
// Splits a Cloudflare previews URL into its Worker, preview name (DELETE) and page (list).
const parseUrl = (url: string) => {
  if (!url.startsWith(BASE)) throw new Error(`unexpected URL ${url}`)
  const parsed = new URL(url)
  const [worker, , name] = url.slice(BASE.length).split("?")[0].split("/")
  return { worker, name: name ? decodeURIComponent(name) : null, page: Number(parsed.searchParams.get("page") ?? "0") }
}
const gitExec = vi.fn(async () => ({ stdout: "a\trefs/heads/dev\nb\trefs/heads/feature/current\n" }))

describe("selectStalePreviews", () => {
  const current = alias("feature/current")
  const live = new Set([alias("dev"), alias("main"), current, alias("feature/open")])

  it("removes ci previews whose branch is gone, oldest first, and keeps live, current and foreign ones", () => {
    const previews = [
      preview(alias("dev"), 20),
      preview(alias("feature/open"), 0.5),
      preview(current, 0.1),
      preview("manual-preview-by-a-person", 40),
      preview(alias("feature/merged-a"), 3),
      preview(alias("feature/merged-b"), 9),
      preview(alias("feature/merged-c"), null),
    ]
    const { stale, deferred, kept } = selectStalePreviews({ previews, currentAlias: current, liveAliases: live, now: NOW })
    expect(stale.map((entry) => entry.name)).toEqual([alias("feature/merged-b"), alias("feature/merged-a"), alias("feature/merged-c")])
    expect(stale.every((entry) => entry.reason === "branch deleted")).toBe(true)
    expect(deferred).toBe(0)
    expect(kept).toEqual({ current: 1, foreign: 1, live: 2, fresh: 0 })
  })

  it("caps removals per run and reports the remainder", () => {
    const previews = Array.from({ length: 5 }, (_, index) => preview(alias(`gone/${index}`), index + 1))
    const { stale, deferred } = selectStalePreviews({ previews, liveAliases: new Set(), now: NOW, limit: 2 })
    expect(stale.map((entry) => entry.name)).toEqual([alias("gone/4"), alias("gone/3")])
    expect(deferred).toBe(3)
  })

  it("without branch liveness only sweeps previews idle past the threshold, never ones of unknown age", () => {
    const previews = [
      preview(alias("a"), DEFAULT_IDLE_DAYS + 1),
      preview(alias("b"), DEFAULT_IDLE_DAYS - 1),
      preview(alias("c"), null),
    ]
    const { stale, kept } = selectStalePreviews({ previews, liveAliases: null, now: NOW })
    expect(stale.map((entry) => entry.name)).toEqual([alias("a")])
    expect(stale[0].reason).toBe(`idle ${DEFAULT_IDLE_DAYS + 1}d`)
    expect(kept.fresh).toBe(2)
  })

  it("dates a preview by deployed_on, then updated_on, then created_on", () => {
    expect(previewLastActivity({ name: "x", deployed_on: "2026-01-02T00:00:00Z", updated_on: "2026-01-03T00:00:00Z" }))
      .toBe(Date.parse("2026-01-02T00:00:00Z"))
    expect(previewLastActivity({ name: "x", deployed_on: null, updated_on: null, created_on: "2026-01-01T00:00:00Z" }))
      .toBe(Date.parse("2026-01-01T00:00:00Z"))
    expect(previewLastActivity({ name: "x" })).toBeNaN()
  })
})

describe("liveBranchAliases", () => {
  it("maps the clone's remote heads to preview aliases", async () => {
    const exec = vi.fn(async () => ({ stdout: "abc\trefs/heads/dev\ndef\trefs/heads/feature/x\nzzz\trefs/pull/1/head\n" }))
    const fetchImpl = vi.fn()
    const result = await liveBranchAliases({ cwd: "/repo", env: {}, exec, fetchImpl: asFetch(fetchImpl) })
    expect(result.source).toBe("git")
    expect([...(result.aliases ?? [])]).toEqual([alias("dev"), alias("feature/x")])
    expect(exec).toHaveBeenCalledWith("git", ["ls-remote", "--heads", "--quiet", "origin"],
      expect.objectContaining({ cwd: "/repo", env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }) }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("falls back to the QA GitHub App with metadata read only when git has no usable remote", async () => {
    const env = { PREVIEW_GITHUB_APP_ID: "12", PREVIEW_GITHUB_APP_INSTALLATION_ID: "34" }
    const exec = vi.fn(async () => { throw new Error("fatal: could not read Username") })
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      const headers = init.headers as Record<string, string>
      if (url === "https://api.github.com/app/installations/34/access_tokens") {
        expect(init.method).toBe("POST")
        expect(headers.Authorization).toBe("Bearer app-jwt")
        expect(JSON.parse(String(init.body))).toEqual({ permissions: { metadata: "read" } })
        return jsonResponse({ token: "ghs_installation" })
      }
      if (url === "https://api.github.com/repos/genesis-ai-dev/aquilla/branches?per_page=100&page=1") {
        expect(headers.Authorization).toBe("Bearer ghs_installation")
        return jsonResponse([{ name: "dev" }, { name: "release/2026/09/24" }])
      }
      throw new Error(`unexpected ${url}`)
    })
    const result = await liveBranchAliases({ env, exec, fetchImpl: asFetch(fetchImpl) })
    expect(result.source).toBe("github")
    expect(result.aliases).toEqual(new Set([alias("dev"), alias("release/2026/09/24")]))
  })

  it("reports unknown liveness when git returns nothing and no App credentials exist", async () => {
    const exec = vi.fn(async () => ({ stdout: "" }))
    const fetchImpl = vi.fn()
    await expect(liveBranchAliases({ env: {}, exec, fetchImpl: asFetch(fetchImpl) })).resolves.toEqual({ source: null, aliases: null })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("cleanupStalePreviews", () => {
  const current = alias("feature/current")

  it("skips without a token or when disabled, touching nothing", async () => {
    const fetchImpl = vi.fn()
    const exec = vi.fn()
    const warn = vi.fn()
    const log = vi.fn()
    await expect(cleanupStalePreviews({ env: {}, fetchImpl: asFetch(fetchImpl), exec, warn, log }))
      .resolves.toEqual({ skipped: "no-token", workers: [] })
    await expect(cleanupStalePreviews({ env: { CLOUDFLARE_API_TOKEN: TOKEN, PREVIEW_CLEANUP: "off" }, fetchImpl: asFetch(fetchImpl), exec, warn, log }))
      .resolves.toEqual({ skipped: "disabled", workers: [] })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain("CLOUDFLARE_API_TOKEN is not set")
  })

  it("sweeps branch-gone ci previews on every preview Worker, sync first, never the current, live or foreign ones", async () => {
    const lists: Record<string, CloudflarePreview[]> = {
      "aquilla-sync-preview": [
        preview(alias("dev"), 5), preview(current, 0.1), preview("manual-preview-by-a-person", 30),
        preview(alias("feature/merged"), 4), preview(alias("feature/older"), 8),
      ],
      "aquilla-auth-preview": [preview(alias("feature/merged"), 4)],
      "aquilla-web-preview": [preview(alias("feature/merged"), 4), preview(alias("feature/older"), 8)],
    }
    const deletes: string[] = []
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
      const { worker, name, page } = parseUrl(url)
      if (init.method === "DELETE") {
        deletes.push(`${worker}/${name}`)
        if (worker === "aquilla-web-preview" && name === alias("feature/older")) return jsonResponse({}, 500)
        if (worker === "aquilla-auth-preview") return jsonResponse({}, 404)
        return jsonResponse({ success: true })
      }
      return jsonResponse({ success: true, result: page === 1 ? lists[worker] : [] })
    })
    const log = vi.fn()
    const warn = vi.fn()
    const result = await cleanupStalePreviews({
      env: { CLOUDFLARE_API_TOKEN: TOKEN }, currentAlias: current, fetchImpl: asFetch(fetchImpl), exec: gitExec, now: NOW, log, warn,
    })
    expect(result.source).toBe("git")
    expect(deletes).toEqual([
      `aquilla-sync-preview/${alias("feature/older")}`,
      `aquilla-sync-preview/${alias("feature/merged")}`,
      `aquilla-auth-preview/${alias("feature/merged")}`,
      `aquilla-web-preview/${alias("feature/older")}`,
      `aquilla-web-preview/${alias("feature/merged")}`,
    ])
    expect(result.workers).toEqual([
      { worker: "aquilla-sync-preview", total: 5, stale: 2, deleted: 2, failed: 0, deferred: 0, kept: { current: 1, foreign: 1, live: 1, fresh: 0 } },
      { worker: "aquilla-auth-preview", total: 1, stale: 1, deleted: 1, failed: 0, deferred: 0, kept: { current: 0, foreign: 0, live: 0, fresh: 0 } },
      { worker: "aquilla-web-preview", total: 2, stale: 2, deleted: 1, failed: 1, deferred: 0, kept: { current: 0, foreign: 0, live: 0, fresh: 0 } },
    ])
    const lines = [...log.mock.calls, ...warn.mock.calls].map(([line]) => String(line))
    expect(lines.join("\n")).not.toContain(TOKEN)
    expect(lines.some((line) => line.includes(`aquilla-web-preview/${alias("feature/older")}: delete failed (HTTP 500)`))).toBe(true)
    expect(lines.some((line) => line.startsWith("[preview-cleanup] aquilla-sync-preview: 5 previews, 2 stale (branch gone per git); deleted 2, failed 0"))).toBe(true)
  })

  it("in dry-run mode names what it would remove and issues no DELETE", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if (init.method === "DELETE") throw new Error("must not delete in a dry run")
      const { worker, page } = parseUrl(url)
      return jsonResponse({ result: worker === "aquilla-sync-preview" && page === 1 ? [preview(alias("feature/merged"), 2)] : [] })
    })
    const log = vi.fn()
    const result = await cleanupStalePreviews({
      env: { CLOUDFLARE_API_TOKEN: TOKEN }, fetchImpl: asFetch(fetchImpl), exec: gitExec, now: NOW, dryRun: true, log, warn: vi.fn(),
    })
    expect(result.workers[0]).toMatchObject({ worker: "aquilla-sync-preview", stale: 1, deleted: 0, failed: 0 })
    expect(log.mock.calls.map(([line]) => String(line)))
      .toContain(`[preview-cleanup] would delete aquilla-sync-preview/${alias("feature/merged")} (branch deleted)`)
  })

  it("paginates the preview list and surfaces a listing failure instead of guessing", async () => {
    const pageOf = (count: number, offset: number) => Array.from({ length: count }, (_, index) => preview(alias(`gone/${offset + index}`), 1))
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if (init.method === "DELETE") return jsonResponse({})
      const { worker, page } = parseUrl(url)
      if (worker === "aquilla-sync-preview") return jsonResponse({ result: page === 1 ? pageOf(100, 0) : page === 2 ? pageOf(7, 100) : [] })
      return jsonResponse({}, 503)
    })
    await expect(cleanupStalePreviews({
      env: { CLOUDFLARE_API_TOKEN: TOKEN }, fetchImpl: asFetch(fetchImpl), exec: gitExec, now: NOW, log: vi.fn(), warn: vi.fn(),
    })).rejects.toThrow("listing aquilla-auth-preview previews answered HTTP 503")
    const syncLists = fetchImpl.mock.calls.filter(([url, init]) => init.method !== "DELETE" && parseUrl(url).worker === "aquilla-sync-preview")
    expect(syncLists.map(([url]) => parseUrl(url).page)).toEqual([1, 2])
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(107)
  })

  it("warns and applies only the idle rule when branch liveness is unknown", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if (init.method === "DELETE") return jsonResponse({})
      const { worker, page } = parseUrl(url)
      return jsonResponse({
        result: worker === "aquilla-sync-preview" && page === 1
          ? [preview(alias("feature/quiet"), DEFAULT_IDLE_DAYS + 3), preview(alias("feature/recent"), 2)]
          : [],
      })
    })
    const warn = vi.fn()
    const result = await cleanupStalePreviews({
      env: { CLOUDFLARE_API_TOKEN: TOKEN }, fetchImpl: asFetch(fetchImpl), exec: vi.fn(async () => ({ stdout: "" })), now: NOW, log: vi.fn(), warn,
    })
    expect(result.source).toBeNull()
    expect(result.workers[0]).toMatchObject({ worker: "aquilla-sync-preview", total: 2, stale: 1, deleted: 1, kept: { fresh: 1 } })
    expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("could not list origin branches"))
  })
})
