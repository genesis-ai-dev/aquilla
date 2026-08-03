import { describe, expect, it } from "vitest"
import { deploymentEnvironmentError } from "../environment-guard"

describe("deployment environment guard", () => {
  it.each([
    ["production", "https://api.aquilla.app/sync/events", "production", "https://api.aquilla.app/identity"],
    ["staging", "https://api.staging.aquilla.app/sync/events", "staging", "https://api.staging.aquilla.app/identity"],
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
