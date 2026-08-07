import { describe, expect, it } from "vitest"
import { deploymentEnvironmentError } from "../environment-guard"

describe("deployment environment guard", () => {
  it.each([
    ["production", "https://api.aquilla.app/sync/events", "production", "https://api.aquilla.app/identity", "aquilla-sync-worker"],
    ["development", "https://api.dev.aquilla.app/sync/events", "development", "https://api.dev.aquilla.app/identity", "aquilla-sync-worker-dev"],
  ])("accepts matching %s bindings", (_label, requestUrl, environment, authWorkerUrl, worker) => {
    expect(
      deploymentEnvironmentError(requestUrl, {
        ENVIRONMENT: environment,
        AUTH_WORKER_URL: authWorkerUrl,
        DEPLOYMENT_WORKER_NAME: worker,
        CF_VERSION_METADATA: { tag: `${worker}-${environment}-commit` },
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

  it("rejects a version uploaded for another Worker namespace", () => {
    expect(
      deploymentEnvironmentError("https://api.aquilla.app/sync/events", {
        ENVIRONMENT: "production",
        AUTH_WORKER_URL: "https://api.aquilla.app/identity",
        DEPLOYMENT_WORKER_NAME: "aquilla-sync-worker",
        CF_VERSION_METADATA: { tag: "aquilla-sync-worker-dev-development-commit" },
      }),
    ).toContain("expected a version tag beginning aquilla-sync-worker-production-")
  })

  it("rejects a missing Worker namespace before database access", () => {
    expect(
      deploymentEnvironmentError("https://api.dev.aquilla.app/sync/events", {
        ENVIRONMENT: "development",
        AUTH_WORKER_URL: "https://api.dev.aquilla.app/identity",
      }),
    ).toContain("expected DEPLOYMENT_WORKER_NAME=aquilla-sync-worker-dev")
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
