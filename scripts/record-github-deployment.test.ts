import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { hasSuccessfulDeployment, recordDeployment } from "./record-github-deployment.mjs"

const SHA = "a".repeat(40)

interface FakeDeployment {
  id: number
}

interface FakeStatus {
  state: string
}

function fakeGitHub({
  existingDeployments = [],
  statusesById = {},
}: {
  existingDeployments?: FakeDeployment[]
  statusesById?: Record<number, FakeStatus[]>
} = {}) {
  const calls: { url: string; method?: string; body?: string }[] = []
  let nextId = 1000
  const fetchImpl = async (url: string, init: { method?: string; body?: string } = {}) => {
    calls.push({ url, method: init.method, body: init.body })
    if (init.method === "POST" && url.endsWith("/deployments")) {
      const id = nextId++
      return { ok: true, json: async () => ({ id }), text: async () => "" }
    }
    if (init.method === "POST" && url.includes("/statuses")) {
      return { ok: true, json: async () => ({ state: "success" }), text: async () => "" }
    }
    if (url.includes("/statuses")) {
      const id = Number(url.match(/\/deployments\/(\d+)\/statuses/)?.[1])
      return { ok: true, json: async () => statusesById[id] ?? [], text: async () => "" }
    }
    if (url.includes("/deployments?")) {
      return { ok: true, json: async () => existingDeployments, text: async () => "" }
    }
    return { ok: false, status: 404, json: async () => null, text: async () => "not found" }
  }
  return { fetchImpl, calls }
}

describe("hasSuccessfulDeployment", () => {
  it("is false when no deployment exists for the sha", async () => {
    const { fetchImpl } = fakeGitHub()
    expect(await hasSuccessfulDeployment({ sha: SHA, environment: "production", token: "t", fetchImpl })).toBe(false)
  })

  it("is true when an existing deployment has a success status", async () => {
    const { fetchImpl } = fakeGitHub({
      existingDeployments: [{ id: 1 }],
      statusesById: { 1: [{ state: "pending" }, { state: "success" }] },
    })
    expect(await hasSuccessfulDeployment({ sha: SHA, environment: "production", token: "t", fetchImpl })).toBe(true)
  })

  it("is false when the only deployment never reached success", async () => {
    const { fetchImpl } = fakeGitHub({
      existingDeployments: [{ id: 1 }],
      statusesById: { 1: [{ state: "failure" }] },
    })
    expect(await hasSuccessfulDeployment({ sha: SHA, environment: "production", token: "t", fetchImpl })).toBe(false)
  })
})

describe("recordDeployment", () => {
  it("creates a deployment and a success status when none exists yet", async () => {
    const { fetchImpl, calls } = fakeGitHub()
    const result = await recordDeployment({
      sha: SHA,
      environment: "production",
      description: "Verified live",
      token: "t",
      fetchImpl,
    })
    expect(result.created).toBe(true)
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/deployments"))).toBe(true)
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/statuses"))).toBe(true)
  })

  it("skips creating a duplicate when a successful deployment already exists", async () => {
    const { fetchImpl, calls } = fakeGitHub({
      existingDeployments: [{ id: 1 }],
      statusesById: { 1: [{ state: "success" }] },
    })
    const result = await recordDeployment({
      sha: SHA,
      environment: "production",
      description: "Verified live",
      token: "t",
      fetchImpl,
    })
    expect(result.created).toBe(false)
    expect(calls.some((c) => c.method === "POST")).toBe(false)
  })

  it("truncates a description over GitHub's 140-character status limit", async () => {
    const { fetchImpl, calls } = fakeGitHub()
    const longDescription = "x".repeat(200)
    await recordDeployment({
      sha: SHA,
      environment: "production",
      description: longDescription,
      token: "t",
      fetchImpl,
    })
    const statusCall = calls.find((c) => c.method === "POST" && c.url.includes("/statuses"))
    const body = JSON.parse(statusCall?.body ?? "{}")
    expect(body.description.length).toBeLessThanOrEqual(140)
  })
})

describe("record-github-deployment.mjs as a command", () => {
  // The entrypoint check once compared against a hand-built `file://` string,
  // which never matches a percent-encoded path, so the script exited 0 having
  // recorded nothing.
  it("runs its main code from a path with a space in it", () => {
    // realpath: on macOS tmpdir() is under /var, a symlink to /private/var.
    // Node resolves the main module through it, so argv[1] and import.meta.url
    // disagree for a reason that has nothing to do with the space.
    const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "record deployment "))
    try {
      const script = path.join(dir, "record-github-deployment.mjs")
      copyFileSync(path.join(import.meta.dirname, "record-github-deployment.mjs"), script)
      const result = spawnSync("node", [script], { encoding: "utf8" })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("Usage: record-github-deployment.mjs")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
