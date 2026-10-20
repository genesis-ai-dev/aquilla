import type { spawn } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import { rotateWorkerSecret, stagedVersionId } from "./cloudflare-secret-rotate.mjs"
import { deploymentVersionTag } from "./cloudflare-version-deploy.mjs"
import { deploymentEnvironmentError as syncDeploymentError } from "../sync-worker/src/environment-guard"
import {
  deploymentEnvironmentError as identityDeploymentError,
  scheduledDeploymentEnvironmentError,
} from "../auth-worker/src/environment-guard"

const STAGED_VERSION = "4cb41f74-fb16-447c-85c5-0013fc825494"
const COMMIT = "8801d93b78159f"

/** The exact success line `wrangler versions secret put` writes to stdout. */
function wranglerSuccess(versionId: string, secretName: string): string {
  return [
    `🌀 Creating the secret for the Worker "aquilla-sync-worker-dev" (development)`,
    `✨ Success! Created version ${versionId} with secret ${secretName}. ➡️  To deploy this version with secret ${secretName} to production traffic use the command "wrangler versions deploy".`,
  ].join("\n")
}

function harness(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const stage = vi.fn(async ({ secretName }: { secretName: string }) => {
    calls.push("stage")
    return wranglerSuccess(STAGED_VERSION, secretName)
  })
  const verifyVersion = vi.fn(async () => { calls.push("verifyVersion"); return STAGED_VERSION })
  const promoteVersion = vi.fn(
    async (_options: { versionId: string }) => { calls.push("promoteVersion") },
  )
  const verifyDeployment = vi.fn(async () => { calls.push("verifyDeployment"); return STAGED_VERSION })
  const verifyLive = vi.fn(async () => { calls.push("verifyLive") })
  return {
    calls,
    stage,
    verifyVersion,
    promoteVersion,
    verifyDeployment,
    verifyLive,
    options: {
      stage,
      verifyVersion,
      promoteVersion,
      verifyDeployment,
      verifyLive,
      log: () => {},
      spawnCommand: (() => { throw new Error("no real wrangler in tests") }) as unknown as typeof spawn,
      ...overrides,
    },
  }
}

describe("verified Worker secret rotation", () => {
  it("reads the staged version id out of wrangler's success line", () => {
    expect(stagedVersionId(wranglerSuccess(STAGED_VERSION, "INWORLD_API_KEY")))
      .toBe(STAGED_VERSION)
  })

  it.each([
    ["no version line", "🌀 Creating the secret for the Worker \"aquilla-sync-worker-dev\""],
    ["a non-UUID id", "✨ Success! Created version latest with secret SYNC_SECRET_KEY."],
    ["empty output", ""],
  ])("refuses to promote when wrangler reports %s", (_label, stdout) => {
    expect(() => stagedVersionId(stdout)).toThrow(/did not report a staged version id/)
  })

  it("never echoes wrangler's secret-handling output in the failure message", () => {
    // The parse failure is reported without the captured stream, which is the
    // channel the secret itself travelled on.
    expect(() => stagedVersionId("✨ Success! Created version oops with secret HUNTER2."))
      .toThrow(/^wrangler versions secret put did not report a staged version id; nothing was promoted$/)
  })

  it("stages a tagged version, verifies its bindings, then promotes that exact id", async () => {
    const { calls, stage, verifyVersion, promoteVersion, options } = harness()

    const result = await rotateWorkerSecret({
      surface: "sync",
      environment: "development",
      secretName: "SYNC_SECRET_KEY",
      sourceId: COMMIT,
      ...options,
    })

    // Bindings are proven before any traffic moves — the ordering is the point.
    expect(calls).toEqual([
      "stage",
      "verifyVersion",
      "promoteVersion",
      "verifyDeployment",
      "verifyLive",
    ])
    expect(stage.mock.calls[0][0]).toMatchObject({
      secretName: "SYNC_SECRET_KEY",
      tag: "aquilla-sync-worker-dev-development-8801d93b7815",
    })
    expect(verifyVersion).toHaveBeenCalledWith(
      "sync",
      "development",
      STAGED_VERSION,
      { workerName: "aquilla-sync-worker-dev" },
    )
    expect(promoteVersion.mock.calls[0][0]).toMatchObject({ versionId: STAGED_VERSION })
    expect(result).toMatchObject({
      versionId: STAGED_VERSION,
      workerName: "aquilla-sync-worker-dev",
      tag: "aquilla-sync-worker-dev-development-8801d93b7815",
    })
  })

  it("does not promote a version whose bindings fail verification", async () => {
    const { promoteVersion, verifyDeployment, verifyLive, options } = harness({
      verifyVersion: vi.fn(async () => {
        throw new Error("HYPERDRIVE expected Hyperdrive 53581197 , received 69bcc10e")
      }),
    })

    await expect(rotateWorkerSecret({
      surface: "sync",
      environment: "development",
      secretName: "SYNC_SECRET_KEY",
      sourceId: COMMIT,
      ...options,
    })).rejects.toThrow(/HYPERDRIVE expected Hyperdrive/)

    expect(promoteVersion).not.toHaveBeenCalled()
    expect(verifyDeployment).not.toHaveBeenCalled()
    expect(verifyLive).not.toHaveBeenCalled()
  })

  it("verifies the identity surface over its live auth endpoints", async () => {
    const { verifyLive, options } = harness()

    await rotateWorkerSecret({
      surface: "identity",
      environment: "production",
      secretName: "OPENROUTER_API_KEY",
      sourceId: COMMIT,
      ...options,
    })

    expect(verifyLive).toHaveBeenCalledWith("production", { surface: "auth" })
  })

  it.each([
    ["web", "production", "SYNC_SECRET_KEY", /cannot rotate secrets on surface/],
    ["sync", "development", "sync_secret_key", /invalid secret name/],
    ["sync", "development", "NOT_A_MANIFEST_SECRET", /not a required secret/],
    ["sync", "nowhere", "SYNC_SECRET_KEY", /unknown deployment environment/],
  ])(
    "refuses %s/%s/%s before staging anything",
    async (surface, environment, secretName, expected) => {
      const { stage, options } = harness()

      await expect(rotateWorkerSecret({
        surface: surface as "sync",
        environment: environment as "development",
        secretName,
        sourceId: COMMIT,
        ...options,
      })).rejects.toThrow(expected)

      expect(stage).not.toHaveBeenCalled()
    },
  )
})

describe("rotation tag satisfies the runtime environment guards (AQU-1361)", () => {
  // Producer → consumer. The deployer stamps the tag; the Workers' own guards
  // consume it at request time. These assert the two agree, so a rotation can
  // never again promote a version the running code refuses to serve.
  it("accepts the rotation tag on the sync API hosts", () => {
    for (const [environment, worker, apiHost] of [
      ["production", "aquilla-sync-worker", "api.aquilla.app"],
      ["development", "aquilla-sync-worker-dev", "api.dev.aquilla.app"],
    ] as const) {
      expect(syncDeploymentError(`https://${apiHost}/sync/events`, {
        ENVIRONMENT: environment,
        AUTH_WORKER_URL: `https://${apiHost}/identity`,
        DEPLOYMENT_WORKER_NAME: worker,
        CF_VERSION_METADATA: { tag: deploymentVersionTag(worker, environment, COMMIT) },
      })).toBeNull()
    }
  })

  it("accepts the rotation tag on the identity API hosts, requests and crons alike", () => {
    for (const [environment, worker, apiHost, appHost] of [
      ["production", "aquilla-identity", "api.aquilla.app", "aquilla.app"],
      ["development", "aquilla-dev-identity", "api.dev.aquilla.app", "dev.aquilla.app"],
    ] as const) {
      const bindings = {
        ENVIRONMENT: environment,
        BASE_URL: `https://${appHost}`,
        SYNC_WORKER_URL: `https://${apiHost}/sync`,
        DEPLOYMENT_WORKER_NAME: worker,
        CF_VERSION_METADATA: { tag: deploymentVersionTag(worker, environment, COMMIT) },
      }
      expect(identityDeploymentError(`https://${apiHost}/identity/api/v2/health`, bindings))
        .toBeNull()
      expect(scheduledDeploymentEnvironmentError(bindings)).toBeNull()
    }
  })

  it("serves Cloudflare's untagged derived version, warning once per guard", () => {
    // What `wrangler secret put` actually promotes — identical script etag,
    // correct development bindings, no workers/tag at all. Refusing it took dev
    // sync down on 2026-09-22 (AQU-1361) and prod identity on 2026-10-20, so
    // both guards now serve it and warn once per isolate instead. Rotation
    // still stages a tagged version so the live one keeps the deployers'
    // binding verification and version-to-commit trail.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const untagged = {
        ENVIRONMENT: "development",
        AUTH_WORKER_URL: "https://api.dev.aquilla.app/identity",
        DEPLOYMENT_WORKER_NAME: "aquilla-sync-worker-dev",
        CF_VERSION_METADATA: {},
      }
      expect(syncDeploymentError("https://api.dev.aquilla.app/sync/events", untagged)).toBeNull()
      expect(syncDeploymentError("https://api.dev.aquilla.app/sync/events", untagged)).toBeNull()

      const untaggedIdentity = {
        ENVIRONMENT: "development",
        BASE_URL: "https://dev.aquilla.app",
        SYNC_WORKER_URL: "https://api.dev.aquilla.app/sync",
        DEPLOYMENT_WORKER_NAME: "aquilla-dev-identity",
        CF_VERSION_METADATA: {},
      }
      expect(identityDeploymentError(
        "https://api.dev.aquilla.app/identity/api/v2/health",
        untaggedIdentity,
      )).toBeNull()
      expect(scheduledDeploymentEnvironmentError(untaggedIdentity)).toBeNull()

      // One warning per Worker module, not per call: the sync guard, then the
      // identity guard, whose request and scheduled paths share one flag.
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        expect.stringContaining("aquilla-sync-worker-dev development is serving an untagged version"),
        expect.stringContaining("aquilla-dev-identity development is serving an untagged version"),
      ])
    } finally {
      warn.mockRestore()
    }
  })

  it("still refuses a rotation tag built for the other environment", () => {
    // The guard keeps its cross-environment teeth: staging with the wrong
    // environment's tag is rejected rather than quietly served.
    expect(syncDeploymentError("https://api.aquilla.app/sync/events", {
      ENVIRONMENT: "production",
      AUTH_WORKER_URL: "https://api.aquilla.app/identity",
      DEPLOYMENT_WORKER_NAME: "aquilla-sync-worker",
      CF_VERSION_METADATA: {
        tag: deploymentVersionTag("aquilla-sync-worker-dev", "development", COMMIT),
      },
    })).toContain("expected a version tag beginning aquilla-sync-worker-production-")
  })
})
