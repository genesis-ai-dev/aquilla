import { describe, it, expect } from "vitest"
import { parseBase, planProxyTargets, mitmdumpModeArgs } from "./mitm-targets"

// The contract under test is the producer/consumer seam between this planner
// and the SPA's own base resolution (`src/lib/frontier/auth.ts`,
// `src/lib/sync/sync-worker-host.ts`, `src/lib/sync/sync-worker-url.ts`). A
// rewritten value that those modules parse differently than intended routes
// traffic around the proxy, so the shapes they accept are pinned here.

describe("parseBase", () => {
  it("splits a full URL into origin and preserved path prefix", () => {
    expect(parseBase("https://api.dev.aquilla.app/identity")).toEqual({
      origin: "https://api.dev.aquilla.app",
      prefix: "/identity",
    })
  })

  it("treats a scheme-less remote host as https", () => {
    expect(parseBase("api.dev.aquilla.app/sync")).toEqual({
      origin: "https://api.dev.aquilla.app",
      prefix: "/sync",
    })
  })

  it("treats a scheme-less local host as http, matching sync-worker-url's isLocalHost", () => {
    expect(parseBase("127.0.0.1:8789")).toEqual({
      origin: "http://127.0.0.1:8789",
      prefix: "",
    })
  })

  it("normalizes the wss:// prefix the sync host tolerates", () => {
    expect(parseBase("wss://api.dev.aquilla.app/sync")).toEqual({
      origin: "https://api.dev.aquilla.app",
      prefix: "/sync",
    })
  })

  it("ignores a trailing slash so the prefix never doubles up", () => {
    expect(parseBase("https://api.dev.aquilla.app/chat/")).toEqual({
      origin: "https://api.dev.aquilla.app",
      prefix: "/chat",
    })
  })

  it("rejects an empty base rather than inventing an origin", () => {
    expect(() => parseBase("   ")).toThrow(/empty base/)
  })
})

describe("planProxyTargets", () => {
  // The .env.local shape: one host, three path prefixes.
  const REMOTE_DEV = {
    VITE_AUTH_BASE: "https://api.dev.aquilla.app/identity",
    VITE_CHAT_BASE: "https://api.dev.aquilla.app/chat",
    VITE_SYNC_WORKER_HOST: "api.dev.aquilla.app/sync",
  }

  it("collapses a shared upstream onto a single listener", () => {
    const plan = planProxyTargets(REMOTE_DEV, 8081)
    expect(plan.targets).toEqual([
      {
        upstream: "https://api.dev.aquilla.app",
        port: 8081,
        vars: ["VITE_AUTH_BASE", "VITE_CHAT_BASE", "VITE_SYNC_WORKER_HOST"],
      },
    ])
  })

  it("rewrites bases to the listener while preserving each path prefix", () => {
    const plan = planProxyTargets(REMOTE_DEV, 8081)
    expect(plan.env).toEqual({
      VITE_AUTH_BASE: "http://127.0.0.1:8081/identity",
      VITE_CHAT_BASE: "http://127.0.0.1:8081/chat",
      // Scheme-less: sync-worker-host.ts strips schemes, and the resulting
      // `127.` host makes sync-worker-url.ts pick http/ws on its own.
      VITE_SYNC_WORKER_HOST: "127.0.0.1:8081/sync",
    })
  })

  it("fans out to one listener per distinct upstream for the local dev stack", () => {
    const plan = planProxyTargets(
      {
        VITE_AUTH_BASE: "http://127.0.0.1:8788",
        VITE_CHAT_BASE: "http://127.0.0.1:8788/chat",
        VITE_SYNC_WORKER_HOST: "127.0.0.1:8789",
      },
      8081,
    )
    expect(plan.targets).toEqual([
      {
        upstream: "http://127.0.0.1:8788",
        port: 8081,
        vars: ["VITE_AUTH_BASE", "VITE_CHAT_BASE"],
      },
      { upstream: "http://127.0.0.1:8789", port: 8082, vars: ["VITE_SYNC_WORKER_HOST"] },
    ])
    expect(plan.env).toEqual({
      VITE_AUTH_BASE: "http://127.0.0.1:8081",
      VITE_CHAT_BASE: "http://127.0.0.1:8081/chat",
      VITE_SYNC_WORKER_HOST: "127.0.0.1:8082",
    })
  })

  it("assigns ports in a stable order regardless of upstream discovery order", () => {
    const a = planProxyTargets(
      { VITE_AUTH_BASE: "https://auth.test", VITE_SYNC_WORKER_HOST: "sync.test" },
      9000,
    )
    const b = planProxyTargets(
      { VITE_SYNC_WORKER_HOST: "sync.test", VITE_AUTH_BASE: "https://auth.test" },
      9000,
    )
    expect(a.env).toEqual(b.env)
    expect(a.env.VITE_AUTH_BASE).toBe("http://127.0.0.1:9000")
  })

  it("warns about an unset base instead of silently leaving it unproxied", () => {
    const plan = planProxyTargets(
      { VITE_AUTH_BASE: "https://api.dev.aquilla.app/identity", VITE_CHAT_BASE: "" },
      8081,
    )
    expect(plan.warnings).toHaveLength(2)
    expect(plan.warnings.join(" ")).toContain("VITE_CHAT_BASE")
    expect(plan.warnings.join(" ")).toContain("VITE_SYNC_WORKER_HOST")
    expect(plan.env).not.toHaveProperty("VITE_CHAT_BASE")
  })

  it("refuses to run when nothing is configured to proxy", () => {
    expect(() => planProxyTargets({}, 8081)).toThrow(/nothing to proxy/)
  })

  it("names the offending variable when a base is unparseable", () => {
    expect(() => planProxyTargets({ VITE_AUTH_BASE: "http://" }, 8081)).toThrow(
      /VITE_AUTH_BASE/,
    )
  })
})

describe("mitmdumpModeArgs", () => {
  it("emits one reverse-mode flag per listener so a single process serves all", () => {
    const plan = planProxyTargets(
      { VITE_AUTH_BASE: "https://auth.test", VITE_SYNC_WORKER_HOST: "sync.test" },
      8081,
    )
    expect(mitmdumpModeArgs(plan.targets)).toEqual([
      "--mode",
      "reverse:https://auth.test@8081",
      "--mode",
      "reverse:https://sync.test@8082",
    ])
  })
})
