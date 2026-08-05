import { describe, expect, it, vi } from "vitest"
import { deploymentPlan, runDeployment } from "../../../scripts/cloudflare-build-deploy.mjs"

describe("Cloudflare Workers Build deployment policy", () => {
  it("uploads, verifies, and promotes main with the production environment", () => {
    expect(deploymentPlan("main")).toEqual({
      mode: "production",
      environment: "production",
      promote: true,
    })
  })

  it("uploads staging as a verified preview without promoting live traffic", () => {
    expect(deploymentPlan("staging")).toEqual({
      mode: "preview",
      environment: "staging",
      promote: false,
    })
  })

  it.each(["dev", "development"])(
    "maps the %s branch explicitly to a development preview",
    (branch) => {
      expect(deploymentPlan(branch)).toEqual({
        mode: "preview",
        environment: "development",
        promote: false,
      })
    },
  )

  it.each(["codex/aqu-771-prod-workers-build-env-guard", "feature/example"])(
    "keeps feature branch %s preview-only with development bindings",
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

  it("passes a traceable development preview plan to the exact-version deployer", async () => {
    const deployVersion = vi.fn().mockResolvedValue({ versionId: "preview-123" })

    await runDeployment({
      surface: "sync",
      branch: "codex/aqu-771-prod-workers-build-env-guard",
      workersCi: "1",
      commitSha: "abcdef1234567890",
      buildUuid: "build-123",
      deployVersion,
    })

    expect(deployVersion).toHaveBeenCalledWith({
      surface: "sync",
      environment: "development",
      promote: false,
      expectedWorker: "aquilla-sync-worker",
      sourceId: "abcdef1234567890",
      sourceLabel: "workers-build:codex/aqu-771-prod-workers-build-env-guard:build-123",
    })
  })

  it("refuses to run the CI deploy command outside Workers Builds", async () => {
    await expect(runDeployment({
      surface: "sync",
      branch: "main",
      workersCi: "",
      commitSha: "abcdef123456",
    })).rejects.toThrow("WORKERS_CI=1 is required")
  })

  it("refuses an untraceable Workers Build", async () => {
    await expect(runDeployment({
      surface: "sync",
      branch: "main",
      workersCi: "1",
      commitSha: "",
    })).rejects.toThrow("WORKERS_CI_COMMIT_SHA is required")
  })

  it("promotes main only after exact-version verification", async () => {
    const deployVersion = vi.fn().mockResolvedValue({ versionId: "production-123" })

    await runDeployment({
      surface: "identity",
      branch: "main",
      workersCi: "1",
      commitSha: "abcdef123456",
      deployVersion,
    })

    expect(deployVersion).toHaveBeenCalledWith(expect.objectContaining({
      surface: "identity",
      environment: "production",
      promote: true,
      expectedWorker: "aquilla-identity",
    }))
  })
})
