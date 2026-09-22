// Regression: the run-scoped env must keep bindings/secrets that live on the
// prototype. index.ts gives routes an env built with Object.create(reqEnv), so
// a spread here silently dropped OPENROUTER_API_KEY and every agent run died
// with `openrouter_error 401` in prod while /chat (using c.env) worked.

import { describe, it, expect } from "vitest"
import { runScopedEnv } from "./agent"
import type { Env } from "../types"

describe("runScopedEnv", () => {
  const base = Object.create({
    OPENROUTER_API_KEY: "sk-inherited",
    SNAPSHOTS: { name: "bucket" },
  }) as Env

  it("keeps prototype-inherited secrets when the run opens its own shim", () => {
    const env = runScopedEnv(base, { own: true })
    expect(env.OPENROUTER_API_KEY).toBe("sk-inherited")
    expect(env.SNAPSHOTS).toBeDefined()
  })

  it("uses the run's shim as AQUILLA_PG", () => {
    const shim = { marker: "run-shim" }
    expect(runScopedEnv(base, shim).AQUILLA_PG).toBe(shim)
  })

  it("returns the base env untouched when there is no shim", () => {
    expect(runScopedEnv(base, null)).toBe(base)
  })
})
