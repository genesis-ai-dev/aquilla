import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  defaultWranglerRegistryDir,
  inspectorPortForWorkerPort,
  isolatedWranglerName,
  wranglerDevArgs,
  wranglerRegistryEnv,
  startWorkerProxyKeepAlive,
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


describe("local worker proxy keep-alive", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("drains probes and keeps traffic below the proxy's five-second idle limit", async () => {
    vi.useFakeTimers()
    const drain = vi.fn().mockResolvedValue(new ArrayBuffer(0))
    const request = vi.fn().mockResolvedValue({ status: 404, arrayBuffer: drain })
    vi.stubGlobal("fetch", request)
    const onError = vi.fn()
    const stop = startWorkerProxyKeepAlive("http://127.0.0.1:9788/", onError)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(request).toHaveBeenCalledTimes(4)
    expect(drain).toHaveBeenCalledTimes(4)
    expect(onError).not.toHaveBeenCalled()
    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(request).toHaveBeenCalledTimes(4)
  })

  it("never overlaps slow probes and aborts the active one on shutdown", async () => {
    vi.useFakeTimers()
    let resolveResponse!: (response: Response) => void
    const request = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveResponse = resolve
    }))
    vi.stubGlobal("fetch", request)
    const onError = vi.fn()
    const stop = startWorkerProxyKeepAlive("http://127.0.0.1:9788/", onError)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(request).toHaveBeenCalledTimes(1)
    const signal = request.mock.calls[0][1].signal as AbortSignal
    stop()
    expect(signal.aborted).toBe(true)
    resolveResponse(new Response("not found", { status: 404 }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(request).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it.each(["disconnect", "HTTP 503"])("reports %s and stops instead of retrying", async (failure) => {
    vi.useFakeTimers()
    const request = failure === "disconnect"
      ? vi.fn().mockRejectedValue(new Error("connection lost"))
      : vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }))
    vi.stubGlobal("fetch", request)
    const onError = vi.fn()
    startWorkerProxyKeepAlive("http://127.0.0.1:9788/", onError)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
