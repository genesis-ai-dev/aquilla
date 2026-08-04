import { EventEmitter } from "node:events"
import { writeFileSync } from "node:fs"
import type { spawn } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import {
  deploymentVersionTag,
  parseWranglerOutput,
  runVerifiedDeployment,
} from "./cloudflare-version-deploy.mjs"

describe("verified Cloudflare version deployment", () => {
  it("parses the exact version ID from Wrangler structured output", () => {
    const output = [
      JSON.stringify({ type: "wrangler-session", version: 1 }),
      JSON.stringify({
        type: "version-upload",
        worker_name: "aquilla-identity",
        version_id: "version-123",
      }),
    ].join("\n")
    expect(parseWranglerOutput(output, "version-upload")).toMatchObject({
      worker_name: "aquilla-identity",
      version_id: "version-123",
    })
  })

  it("tags versions with the actual Worker namespace and environment", () => {
    expect(
      deploymentVersionTag("aquilla-identity", "development", "abcdef1234567890"),
    ).toBe("aquilla-identity-development-abcdef123456")
  })

  it("verifies the exact production version before promotion and again after", async () => {
    const order: string[] = []
    const upload = vi.fn(async () => {
      order.push("upload")
      return "version-123"
    })
    const verifyVersion = vi.fn(async () => {
      order.push("verify-version")
      return "version-123"
    })
    const promoteVersion = vi.fn(async () => {
      order.push("promote")
    })
    const verifyDeployment = vi.fn(async () => {
      order.push("verify-deployment")
      return "version-123"
    })

    await runVerifiedDeployment({
      surface: "identity",
      environment: "production",
      expectedWorker: "aquilla-identity",
      sourceId: "abcdef123456",
      upload,
      verifyVersion,
      promoteVersion,
      verifyDeployment,
    })

    expect(order).toEqual([
      "upload",
      "verify-version",
      "promote",
      "verify-deployment",
    ])
  })

  it("uses the environment-configured Worker name while promoting the captured ID", async () => {
    const calls: string[][] = []
    const spawnCommand = ((_: string, args: readonly string[], options: {
      env?: NodeJS.ProcessEnv
    }) => {
      calls.push([...args])
      if (args.includes("upload")) {
        writeFileSync(
          options.env?.WRANGLER_OUTPUT_FILE_PATH as string,
          `${JSON.stringify({
            type: "version-upload",
            worker_name: "aquilla-identity",
            version_id: "version-123",
          })}\n`,
        )
      }
      const child = new EventEmitter()
      queueMicrotask(() => child.emit("exit", 0, null))
      return child
    }) as unknown as typeof spawn

    await runVerifiedDeployment({
      surface: "identity",
      environment: "production",
      expectedWorker: "aquilla-identity",
      sourceId: "abcdef123456",
      spawnCommand,
      verifyVersion: vi.fn().mockResolvedValue("version-123"),
      verifyDeployment: vi.fn().mockResolvedValue("version-123"),
    })

    expect(calls).toEqual([
      expect.arrayContaining([
        "versions",
        "upload",
        "--env=production",
      ]),
      expect.arrayContaining([
        "versions",
        "deploy",
        "version-123@100%",
        "--env=production",
      ]),
      expect.arrayContaining([
        "triggers",
        "deploy",
        "--env=production",
      ]),
    ])
    expect(calls.flat()).not.toContain("--name=aquilla-identity")
  })

  it("verifies development previews without promoting them", async () => {
    const verifyVersion = vi.fn().mockResolvedValue("preview-123")
    const promoteVersion = vi.fn()
    const verifyDeployment = vi.fn()

    await runVerifiedDeployment({
      surface: "identity",
      environment: "development",
      promote: false,
      expectedWorker: "aquilla-identity",
      sourceId: "abcdef123456",
      upload: vi.fn().mockResolvedValue("preview-123"),
      verifyVersion,
      promoteVersion,
      verifyDeployment,
    })

    expect(verifyVersion).toHaveBeenCalledWith(
      "identity",
      "development",
      "preview-123",
      { workerName: "aquilla-identity" },
    )
    expect(promoteVersion).not.toHaveBeenCalled()
    expect(verifyDeployment).not.toHaveBeenCalled()
  })

  it("refuses to promote environment bindings into another Worker namespace", async () => {
    await expect(
      runVerifiedDeployment({
        surface: "identity",
        environment: "development",
        expectedWorker: "aquilla-identity",
        sourceId: "abcdef123456",
      }),
    ).rejects.toThrow("refusing to promote development bindings to aquilla-identity")
  })
})
