import { readdirSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  authStateFile,
  readPersistedSession,
  writePersistedSession,
} from "../e2e/helpers/auth-state"
import { resetBackend } from "../e2e/helpers/seed"
import {
  isRetryableTransportError,
  withTransportRetry,
} from "../e2e/helpers/transport-retry"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolute)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : []
  })
}

describe("E2E determinism guardrails", () => {
  it("runs before every standard E2E entrypoint", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> }
    const scripts = packageJson.scripts ?? {}

    expect(scripts["test:e2e:guard"]).toBe(
      "vitest run scripts/e2e-determinism.test.ts",
    )

    for (const scriptName of [
      "test:e2e:smoke",
      "test:e2e",
      "test:e2e:shard",
      "test:e2e:ui",
      "test:e2e:debug",
    ]) {
      expect(scripts[scriptName], `${scriptName} must run the policy guard`).toMatch(
        /^pnpm run test:e2e:guard && /,
      )
    }
  })

  it("keeps UI waits tied to observable state", () => {
    const files = [
      ...sourceFiles(path.join(REPO_ROOT, "e2e/specs")),
      ...sourceFiles(path.join(REPO_ROOT, "e2e/helpers")),
    ]
    const violations: string[] = []

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      const relative = path.relative(REPO_ROOT, file)
      if (/\.waitForTimeout\s*\(/.test(source)) {
        violations.push(`${relative}: fixed browser sleep`)
      }
      if (/waitForLoadState\s*\(\s*["']networkidle["']\s*\)/.test(source)) {
        violations.push(`${relative}: networkidle used as application readiness`)
      }
      if (file.endsWith(".smoke.spec.ts") && /\.catch\(\s*\(\)\s*=>\s*false\s*\)/.test(source)) {
        violations.push(`${relative}: swallowed conditional probe`)
      }
      if (
        file.endsWith(".smoke.spec.ts")
        && /expect\([\s\S]{0,200}?\.locator\(\s*["']\[data-cell-id\]["']\s*\)\.first\(\)\s*\)\.toBeVisible/.test(source)
      ) {
        violations.push(`${relative}: bypasses Workspace.waitForEditor readiness contract`)
      }
    }

    expect(violations).toEqual([])
  })
})

describe("E2E auth-state isolation", () => {
  it("namespaces sidecars by identity-worker origin", () => {
    const root = path.join(os.tmpdir(), "aquilla-auth-state-paths")
    const first = authStateFile("alice", "http://127.0.0.1:8787", root)
    const second = authStateFile("alice", "http://127.0.0.1:8887", root)

    expect(first).not.toBe(second)
    expect(path.dirname(first)).not.toBe(path.dirname(second))
  })

  it("never exposes partial JSON during concurrent publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aquilla-auth-state-"))
    const base = "http://127.0.0.1:8787"
    const sessions = Array.from({ length: 40 }, (_, index) => ({
      jwt: `token-${index}-${"x".repeat(16_384)}`,
      username: "alice",
      createdAt: new Date(index).toISOString(),
    }))

    try {
      await writePersistedSession(sessions[0], base, root)
      const readers = Array.from({ length: 10 }, async () => {
        for (let index = 0; index < 80; index++) {
          const session = await readPersistedSession("alice", base, root)
          expect(session.username).toBe("alice")
          expect(session.jwt).toMatch(/^token-\d+-x+$/)
        }
      })
      const writers = sessions.slice(1).map((session) =>
        writePersistedSession(session, base, root),
      )

      await Promise.all([...readers, ...writers])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("E2E backend-reset transport retry", () => {
  it("treats ECONNREFUSED / fetch failed as retryable and HTTP errors as not", () => {
    expect(isRetryableTransportError(
      Object.assign(new TypeError("fetch failed"), {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:8787"),
      }),
    )).toBe(true)
    expect(isRetryableTransportError(new Error("backend reset failed: HTTP 500 — boom"))).toBe(false)
  })

  it("retries a transient transport error then returns", async () => {
    let calls = 0
    const result = await withTransportRetry(async () => {
      calls += 1
      if (calls < 2) throw new TypeError("fetch failed")
      return "ok"
    })
    expect(result).toBe("ok")
    expect(calls).toBe(2)
  })

  it("retries POST /__test__/reset when identity flaps, then succeeds", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls < 2) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: new Error("connect ECONNREFUSED 127.0.0.1:8787"),
        })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    try {
      await resetBackend()
      expect(calls).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("aborts the e2e shard when identity or sync wrangler exits", () => {
    const source = readFileSync(path.join(REPO_ROOT, "scripts/e2e-up.ts"), "utf8")
    expect(source).toContain("function abortIfWorkerDies")
    expect(source).toMatch(/abortIfWorkerDies\(identity,\s*"identity"\)/)
    expect(source).toMatch(/abortIfWorkerDies\(sync,\s*"sync"\)/)
  })
})
