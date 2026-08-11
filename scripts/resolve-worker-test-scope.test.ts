import { describe, expect, it } from "vitest"
import { formatWorkerTestScope, resolveWorkerTestScope } from "./resolve-worker-test-scope.mjs"

describe("worker test scope", () => {
  it.each([
    [["src/components/App.tsx"], { auth: false, sync: false, agent: false }],
    [["auth-worker/src/index.ts"], { auth: true, sync: false, agent: false }],
    [["src/lib/migrate/ids.ts"], { auth: true, sync: false, agent: false }],
    [["sync-worker/src/index.ts"], { auth: false, sync: true, agent: false }],
    [["agent-worker/src/index.ts"], { auth: false, sync: false, agent: true }],
    [["auth-worker/src/index.ts", "sync-worker/src/index.ts"], { auth: true, sync: true, agent: false }],
  ])("selects suites for %j", (files, expected) => {
    expect(resolveWorkerTestScope(files)).toEqual(expected)
  })

  it.each([
    "pnpm-lock.yaml",
    "package.json",
    "tsconfig.json",
    "db/shim/postgres.ts",
    "shared/import-contract.ts",
    "config/cloudflare-deployments.json",
    "scripts/cloudflare-version-deploy.mjs",
    "scripts/resolve-worker-test-scope.mjs",
    "scripts/verify-worker-deployment.mjs",
    "scripts/verify-live-environment.mjs",
    ".github/workflows/ci.yml",
    ".github/workflows/deploy-workers.yml",
  ])("runs every suite for shared input %s", (file) => {
    expect(resolveWorkerTestScope([file])).toEqual({ auth: true, sync: true, agent: true })
  })

  it("fails open when the caller cannot produce a trustworthy diff", () => {
    expect(resolveWorkerTestScope([], { forceAll: true }))
      .toEqual({ auth: true, sync: true, agent: true })
  })

  it("emits stable GitHub output keys", () => {
    expect(formatWorkerTestScope({ auth: true, sync: false, agent: true }))
      .toBe("auth=true\nsync=false\nagent=true\n")
  })
})
