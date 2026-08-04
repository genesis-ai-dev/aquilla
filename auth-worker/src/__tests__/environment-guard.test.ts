import { describe, expect, it, vi } from "vitest"
import app from "../index"
import type { Env } from "../types"
import {
  deploymentEnvironmentError,
  scheduledDeploymentEnvironmentError,
} from "../environment-guard"

const DEPLOYMENTS = {
  production: {
    apiUrl: "https://api.aquilla.app/identity/api/v2/health",
    worker: "aquilla-identity",
    baseUrl: "https://aquilla.app",
    syncWorkerUrl: "https://api.aquilla.app/sync",
  },
  staging: {
    apiUrl: "https://api.staging.aquilla.app/identity/api/v2/health",
    worker: "aquilla-staging-identity",
    baseUrl: "https://staging.aquilla.app",
    syncWorkerUrl: "https://api.staging.aquilla.app/sync",
  },
  development: {
    apiUrl: "https://api.dev.aquilla.app/identity/api/v2/health",
    worker: "aquilla-dev-identity",
    baseUrl: "https://dev.aquilla.app",
    syncWorkerUrl: "https://api.dev.aquilla.app/sync",
  },
} as const

function bindings(environment: keyof typeof DEPLOYMENTS, overrides: Partial<Env> = {}): Env {
  const deployment = DEPLOYMENTS[environment]
  return {
    ENVIRONMENT: environment,
    BASE_URL: deployment.baseUrl,
    SYNC_WORKER_URL: deployment.syncWorkerUrl,
    DEPLOYMENT_WORKER_NAME: deployment.worker,
    CF_VERSION_METADATA: {
      id: `${environment}-version`,
      tag: `${deployment.worker}-${environment}-abc123`,
      timestamp: "2026-08-04T00:00:00Z",
    },
    ...overrides,
  } as unknown as Env
}

describe("identity deployment environment guard", () => {
  it.each(["production", "staging", "development"] as const)(
    "accepts matching %s bindings",
    (environment) => {
      expect(
        deploymentEnvironmentError(
          DEPLOYMENTS[environment].apiUrl,
          bindings(environment),
        ),
      ).toBeNull()
    },
  )

  it.each([
    ["ENVIRONMENT", { ENVIRONMENT: "development" }],
    ["BASE_URL", { BASE_URL: "https://dev.aquilla.app" }],
    ["SYNC_WORKER_URL", { SYNC_WORKER_URL: "https://api.dev.aquilla.app/sync" }],
    ["DEPLOYMENT_WORKER_NAME", { DEPLOYMENT_WORKER_NAME: "aquilla-dev-identity" }],
    ["version tag", { CF_VERSION_METADATA: { id: "dev", tag: "aquilla-dev-identity-development-abc", timestamp: "2026-08-04T00:00:00Z" } }],
  ] satisfies Array<[string, Partial<Env>]>) (
    "rejects a production %s mismatch",
    (binding, overrides) => {
      expect(
        deploymentEnvironmentError(
          DEPLOYMENTS.production.apiUrl,
          bindings("production", overrides),
        ),
      ).toContain(binding === "version tag" ? "version tag" : `expected ${binding}`)
    },
  )

  it("allows local and workers.dev hosts", () => {
    const localBindings = {
      ENVIRONMENT: "local",
      BASE_URL: "http://127.0.0.1:5173",
      SYNC_WORKER_URL: "http://127.0.0.1:8788",
    }
    expect(
      deploymentEnvironmentError("http://127.0.0.1:8787/api/v2/health", localBindings),
    ).toBeNull()
    expect(
      deploymentEnvironmentError(
        "https://aquilla-dev-identity.example.workers.dev/api/v2/health",
        localBindings,
      ),
    ).toBeNull()
  })

  it("returns 503 before attempting to open Postgres", async () => {
    const response = await app.request(
      DEPLOYMENTS.production.apiUrl,
      {},
      bindings("development") as Env,
    )

    expect(response.status).toBe(503)
    expect(await response.text()).toBe(
      "Worker deployment configuration does not match this API environment",
    )
  })

  it.each(["production", "staging", "development"] as const)(
    "accepts matching %s scheduled bindings",
    (environment) => {
      expect(scheduledDeploymentEnvironmentError(bindings(environment))).toBeNull()
    },
  )

  it("rejects scheduled work when the uploaded Worker namespace does not match", () => {
    expect(
      scheduledDeploymentEnvironmentError(bindings("development", {
        CF_VERSION_METADATA: {
          id: "preview-version",
          tag: "aquilla-identity-development-abc123",
          timestamp: "2026-08-04T00:00:00Z",
        },
      })),
    ).toContain("expected a version tag beginning aquilla-dev-identity-development-")
  })

  it("returns before scheduled work opens Hyperdrive", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    let openedHyperdrive = false
    const env = bindings("development", {
      CF_VERSION_METADATA: {
        id: "preview-version",
        tag: "aquilla-identity-development-abc123",
        timestamp: "2026-08-04T00:00:00Z",
      },
    })
    Object.defineProperty(env, "HYPERDRIVE", {
      get() {
        openedHyperdrive = true
        return { connectionString: "postgres://should-not-open" }
      },
    })

    await app.scheduled(
      {} as ScheduledController,
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    )

    expect(openedHyperdrive).toBe(false)
    error.mockRestore()
  })
})
