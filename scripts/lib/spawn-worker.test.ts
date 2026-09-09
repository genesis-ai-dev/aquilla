import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  defaultWranglerRegistryDir,
  inspectorPortForWorkerPort,
  isolatedWranglerName,
  wranglerDevArgs,
  wranglerRegistryEnv,
} from "./spawn-worker"

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

  it("overrides the toml worker name so registry heartbeat files do not collide", () => {
    const args = wranglerDevArgs({
      port: 8988,
      name: "aquilla-sync-worker-local-e2e-s2",
    })
    expect(args).toContain("--name")
    expect(args[args.indexOf("--name") + 1]).toBe("aquilla-sync-worker-local-e2e-s2")
  })
})

describe("Wrangler local registry isolation", () => {
  it("namespaces the file registry by worker label and port", () => {
    const identity = defaultWranglerRegistryDir("identity", 8787)
    const sync = defaultWranglerRegistryDir("sync", 8788)
    const shardSync = defaultWranglerRegistryDir("sync", 8988)

    expect(identity).not.toBe(sync)
    expect(sync).not.toBe(shardSync)
    expect(path.basename(identity)).toBe("aquilla-wrangler-registry-identity-8787")
    expect(path.basename(shardSync)).toBe("aquilla-wrangler-registry-sync-8988")
  })

  it("points Wrangler and Miniflare at the isolated registry directory", () => {
    const dir = "/tmp/aquilla-wrangler-registry-sync-8988"
    expect(wranglerRegistryEnv(dir)).toEqual({
      WRANGLER_REGISTRY_PATH: dir,
      MINIFLARE_REGISTRY_PATH: dir,
    })
  })

  it("gives each e2e stack a worker name that cannot collide with pnpm dev", () => {
    expect(isolatedWranglerName("aquilla-sync-worker-local", "")).toBe(
      "aquilla-sync-worker-local-e2e",
    )
    expect(isolatedWranglerName("aquilla-sync-worker-local", "-s2")).toBe(
      "aquilla-sync-worker-local-e2e-s2",
    )
    expect(isolatedWranglerName("aquilla-identity-local", "-s0")).toBe(
      "aquilla-identity-local-e2e-s0",
    )
    expect(isolatedWranglerName("aquilla-sync-worker-local", "-s0")).not.toBe(
      "aquilla-sync-worker-local",
    )
  })
})
