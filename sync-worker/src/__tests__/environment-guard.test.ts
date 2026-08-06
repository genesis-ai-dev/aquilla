import { describe, expect, it } from "vitest"
import {
  deploymentEnvironmentError,
  isDeployedEnvironment,
  unauthenticatedBypassError,
} from "../environment-guard"

describe("deployment environment guard", () => {
  it.each([
    ["production", "https://api.aquilla.app/sync/events", "production", "https://api.aquilla.app/identity"],
    ["development", "https://api.dev.aquilla.app/sync/events", "development", "https://api.dev.aquilla.app/identity"],
  ])("accepts matching %s bindings", (_label, requestUrl, environment, authWorkerUrl) => {
    expect(
      deploymentEnvironmentError(requestUrl, {
        ENVIRONMENT: environment,
        AUTH_WORKER_URL: authWorkerUrl,
      }),
    ).toBeNull()
  })

  it("rejects development bindings on the production API", () => {
    expect(
      deploymentEnvironmentError("https://api.aquilla.app/sync/events", {
        ENVIRONMENT: "development",
        AUTH_WORKER_URL: "https://api.dev.aquilla.app/identity",
      }),
    ).toContain("expected ENVIRONMENT=production")
  })

  it("rejects a cross-environment identity URL even when the environment label matches", () => {
    expect(
      deploymentEnvironmentError("https://api.aquilla.app/sync/events", {
        ENVIRONMENT: "production",
        AUTH_WORKER_URL: "https://api.dev.aquilla.app/identity",
      }),
    ).toContain("expected AUTH_WORKER_URL host api.aquilla.app")
  })

  it("allows local and workers.dev hosts", () => {
    expect(
      deploymentEnvironmentError("http://127.0.0.1:8787/events", {
        ENVIRONMENT: "local",
        AUTH_WORKER_URL: "http://127.0.0.1:8788",
      }),
    ).toBeNull()
    expect(
      deploymentEnvironmentError("https://aquilla-sync-worker.example.workers.dev/events", {
        ENVIRONMENT: "development",
        AUTH_WORKER_URL: "https://api.dev.aquilla.app/identity",
      }),
    ).toBeNull()
  })
})

describe("ALLOW_UNAUTHENTICATED guard", () => {
  it.each(["production", "development"])(
    "rejects the auth bypass in ENVIRONMENT=%s",
    (environment) => {
      expect(
        unauthenticatedBypassError({ ENVIRONMENT: environment, ALLOW_UNAUTHENTICATED: "true" }),
      ).toContain("must never be enabled on a deployed worker")
    },
  )

  it("allows the bypass in local development", () => {
    // `pnpm dev` runs sync-worker on the wrangler.toml top-level vars block,
    // which is ENVIRONMENT="local" — the bypass has to keep working there.
    expect(
      unauthenticatedBypassError({ ENVIRONMENT: "local", ALLOW_UNAUTHENTICATED: "true" }),
    ).toBeNull()
  })

  it("allows the bypass when ENVIRONMENT is unset", () => {
    // `[env.e2e]` declares no vars block, and env blocks don't inherit
    // `[vars]`, so the E2E stack sees ENVIRONMENT unset.
    expect(unauthenticatedBypassError({ ALLOW_UNAUTHENTICATED: "true" })).toBeNull()
  })

  it.each([undefined, "false", "1", "TRUE"])(
    "is a no-op when ALLOW_UNAUTHENTICATED is %s, even in production",
    (flag) => {
      expect(
        unauthenticatedBypassError({ ENVIRONMENT: "production", ALLOW_UNAUTHENTICATED: flag }),
      ).toBeNull()
    },
  )

  it("classifies deployed vs local environments", () => {
    expect(isDeployedEnvironment({ ENVIRONMENT: "production" })).toBe(true)
    expect(isDeployedEnvironment({ ENVIRONMENT: "development" })).toBe(true)
    expect(isDeployedEnvironment({ ENVIRONMENT: "local" })).toBe(false)
    expect(isDeployedEnvironment({})).toBe(false)
  })
})
