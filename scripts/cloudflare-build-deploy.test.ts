import { describe, expect, it, vi } from "vitest"
import { deploymentPlan, runDeployment } from "./cloudflare-build-deploy.mjs"

const workersEnv = (branch: string) => ({
  WORKERS_CI: "1",
  WORKERS_CI_BRANCH: branch,
  WORKERS_CI_COMMIT_SHA: "abcdef1234567890",
  WORKERS_CI_BUILD_UUID: "build-123",
})

describe("Cloudflare Workers Builds deployment policy", () => {
  it("uploads main with production bindings without promoting traffic", () => {
    expect(deploymentPlan("main")).toEqual({
      mode: "preview",
      environment: "production",
      promote: false,
    })
  })

  it.each(["dev", "development", "staging", "temp-staging", "feature/example"])(
    "keeps %s preview-only with development bindings",
    (branch) => {
      expect(deploymentPlan(branch)).toEqual({
        mode: "preview",
        environment: "development",
        promote: false,
      })
    },
  )

  it.each([undefined, "", "   "])("fails closed when the branch is %s", (branch) => {
    expect(() => deploymentPlan(branch)).toThrow("WORKERS_CI_BRANCH is required")
  })

  it("passes the exact development Worker to the verified uploader", async () => {
    const deployVersion = vi.fn().mockResolvedValue({ versionId: "preview-123" })

    await runDeployment({ surface: "sync", env: workersEnv("feature/example"), deployVersion })

    expect(deployVersion).toHaveBeenCalledWith({
      surface: "sync",
      environment: "development",
      promote: false,
      expectedWorker: "aquilla-sync-worker-dev",
      sourceId: "abcdef1234567890",
      sourceLabel: "workers-build:feature/example:build-123",
    })
  })

  it("passes the exact production Worker without granting promotion", async () => {
    const deployVersion = vi.fn().mockResolvedValue({ versionId: "production-preview-123" })

    await runDeployment({ surface: "identity", env: workersEnv("main"), deployVersion })

    expect(deployVersion).toHaveBeenCalledWith(expect.objectContaining({
      surface: "identity",
      environment: "production",
      promote: false,
      expectedWorker: "aquilla-identity",
    }))
  })

  it.each([
    [{ WORKERS_CI_BRANCH: "main", WORKERS_CI_COMMIT_SHA: "abc" }, "WORKERS_CI=1"],
    [{ WORKERS_CI: "1", WORKERS_CI_COMMIT_SHA: "abc" }, "WORKERS_CI_BRANCH"],
    [{ WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" }, "WORKERS_CI_COMMIT_SHA"],
  ])("fails closed for incomplete metadata", async (env, message) => {
    await expect(runDeployment({ surface: "web", env, deployVersion: vi.fn() }))
      .rejects.toThrow(message)
  })
})
