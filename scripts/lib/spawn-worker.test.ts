import { describe, expect, it } from "vitest"
import { wranglerDevArgs } from "./spawn-worker"

describe("managed Wrangler dev command", () => {
  it("asks the OS for an inspector port for every concurrent stack", () => {
    const identity = wranglerDevArgs({ port: 8787 })
    const sync = wranglerDevArgs({ port: 8788 })

    for (const args of [identity, sync]) {
      expect(args).toContain("--inspector-port")
      expect(args[args.indexOf("--inspector-port") + 1]).toBe("0")
    }
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
