import { describe, expect, it, vi } from "vitest"
import { deploymentExpectation } from "./cloudflare-deployment-manifest.mjs"
import {
  validateActiveDeployment,
  validateProductionDeployment,
  validateWorkerVersion,
  verifyWorkerVersion,
} from "./verify-worker-deployment.mjs"

const PRODUCTION_VERSION_ID = "def9652f-2843-4b94-bb52-b9d03a4cd25b"

function deployment(versionId = PRODUCTION_VERSION_ID) {
  return {
    versions: [{ version_id: versionId, percentage: 100 }],
  }
}

function identityVersion(
  environment: "production" | "staging" | "development" = "production",
  overrides: Record<string, unknown>[] = [],
) {
  const expectation = deploymentExpectation("identity", environment)
  const bindings: Record<string, unknown>[] = [
    ...Object.entries(expectation.plainText)
      .map(([name, text]) => ({ name, text, type: "plain_text" })),
    ...Object.entries(expectation.hyperdrives)
      .map(([name, id]) => ({ name, id, type: "hyperdrive" })),
    ...Object.entries(expectation.r2Buckets)
      .map(([name, bucket_name]) => ({ name, bucket_name, type: "r2_bucket" })),
    ...expectation.requiredSecrets.map((name: string) => ({ name, type: "secret_text" })),
    ...Object.entries(expectation.requiredBindings)
      .map(([name, type]) => ({ name, type })),
  ]

  for (const override of overrides) {
    const index = bindings.findIndex((binding) => binding.name === override.name)
    if (index === -1) bindings.push(override)
    else bindings[index] = override
  }

  return {
    id: PRODUCTION_VERSION_ID,
    resources: { bindings },
  }
}

describe("Worker deployment verifier", () => {
  it("accepts the production identity version at 100% traffic", () => {
    expect(
      validateProductionDeployment(
        deployment(),
        identityVersion(),
        deploymentExpectation("identity", "production"),
      ),
    ).toBe(PRODUCTION_VERSION_ID)
  })

  it("accepts an exact development preview without production traffic", () => {
    expect(
      validateWorkerVersion(
        identityVersion("development"),
        deploymentExpectation("identity", "development"),
        PRODUCTION_VERSION_ID,
      ),
    ).toBe(PRODUCTION_VERSION_ID)
  })

  it("rejects a promoted version carrying development bindings", () => {
    expect(() =>
      validateWorkerVersion(
        identityVersion("development"),
        deploymentExpectation("identity", "production"),
        PRODUCTION_VERSION_ID,
      )
    ).toThrow("ENVIRONMENT expected production, received development")
  })

  it("rejects missing required bindings", () => {
    const version = identityVersion()
    version.resources.bindings = version.resources.bindings.filter(
      (binding) => binding.name !== "SECRET_KEY",
    )

    expect(() =>
      validateWorkerVersion(
        version,
        deploymentExpectation("identity", "production"),
        PRODUCTION_VERSION_ID,
      )
    ).toThrow("missing required secret binding SECRET_KEY")
  })

  it("rejects production traffic splits", () => {
    expect(() =>
      validateActiveDeployment(
        {
          versions: [
            { version_id: PRODUCTION_VERSION_ID, percentage: 90 },
            { version_id: "development-version", percentage: 10 },
          ],
        },
        PRODUCTION_VERSION_ID,
        deploymentExpectation("identity", "production"),
      )
    ).toThrow("traffic must contain exactly one version at 100%")
  })

  it("views and validates the exact uploaded version ID", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify(identityVersion("development")))
    await expect(
      verifyWorkerVersion("identity", "development", PRODUCTION_VERSION_ID, {
        workerName: "aquilla-identity",
        run,
        log: vi.fn(),
      }),
    ).resolves.toBe(PRODUCTION_VERSION_ID)
    expect(run).toHaveBeenCalledWith(
      "pnpm",
      expect.arrayContaining([
        "versions",
        "view",
        PRODUCTION_VERSION_ID,
        "--name=aquilla-identity",
      ]),
      expect.any(Object),
    )
  })
})
