import { EventEmitter } from "node:events"
import type { spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import { deploymentPlan, runDeployment } from "../../scripts/cloudflare-build-deploy.mjs"

describe("Cloudflare Workers Build deployment policy", () => {
  it("deploys main with the explicit production environment", () => {
    expect(deploymentPlan("main")).toEqual({
      mode: "production",
      environment: "production",
      args: ["deploy", "--env=production"],
    })
  })

  it("uploads staging as a preview without promoting live traffic", () => {
    expect(deploymentPlan("staging")).toEqual({
      mode: "preview",
      environment: "staging",
      args: ["versions", "upload", "--env=staging"],
    })
  })

  it.each(["dev", "development"])(
    "maps the %s branch explicitly to a development preview",
    (branch) => {
      expect(deploymentPlan(branch)).toEqual({
        mode: "preview",
        environment: "development",
        args: ["versions", "upload", "--env=development"],
      })
    },
  )

  it.each(["codex/aqu-771-prod-workers-build-env-guard", "feature/example"])(
    "keeps feature branch %s preview-only with development bindings",
    (branch) => {
      expect(deploymentPlan(branch)).toEqual({
        mode: "preview",
        environment: "development",
        args: ["versions", "upload", "--env=development"],
      })
    },
  )

  it.each([undefined, "", "   "])("fails closed when the branch is %s", (branch) => {
    expect(() => deploymentPlan(branch)).toThrow("WORKERS_CI_BRANCH is required")
  })

  it("passes the resolved preview plan to Wrangler", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const spawnCommand = ((command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] })
      const child = new EventEmitter()
      queueMicrotask(() => child.emit("exit", 0, null))
      return child
    }) as unknown as typeof spawn

    await runDeployment({
      branch: "codex/aqu-771-prod-workers-build-env-guard",
      workersCi: "1",
      spawnCommand,
    })

    expect(calls).toEqual([
      {
        command: "pnpm",
        args: ["exec", "wrangler", "versions", "upload", "--env=development"],
      },
    ])
  })

  it("refuses to run the CI deploy command outside Workers Builds", async () => {
    await expect(runDeployment({ branch: "main", workersCi: "" }))
      .rejects.toThrow("WORKERS_CI=1 is required")
  })
})
