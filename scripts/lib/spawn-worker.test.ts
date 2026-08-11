import { describe, expect, it } from "vitest"
import { inspectorPortForWorkerPort, wranglerDevArgs } from "./spawn-worker"

describe("managed Wrangler dev command", () => {
  it("derives stable, collision-free inspector ports for concurrent stacks", () => {
    const workerPorts = [8787, 8788, 8887, 8888, 8987, 8988]
    const inspectorPorts = workerPorts.map((port) => {
      const args = wranglerDevArgs({ port })

      expect(args).toContain("--inspector-port")
      return Number(args[args.indexOf("--inspector-port") + 1])
    })

    expect(inspectorPorts).toEqual(workerPorts.map(inspectorPortForWorkerPort))
    expect(new Set(inspectorPorts).size).toBe(workerPorts.length)
    expect(inspectorPorts).not.toContain(0)
  })

  it("preserves explicit inspector and extra Wrangler arguments", () => {
    expect(wranglerDevArgs({
      port: 8887,
      inspectorPort: 9330,
      extraArgs: ["--persist-to", ".wrangler-test-state"],
    })).toEqual([
      "wrangler",
      "dev",
      "--local",
      "--port",
      "8887",
      "--ip",
      "127.0.0.1",
      "--inspector-port",
      "9330",
      "--persist-to",
      ".wrangler-test-state",
    ])
  })
})
