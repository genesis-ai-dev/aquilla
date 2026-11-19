import { describe, expect, it, vi } from "vitest"
import { deploymentExpectation } from "./cloudflare-deployment-manifest.mjs"
import { runVerifiedDeployment } from "./cloudflare-version-deploy.mjs"
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
  it.each(["production", "development"] as const)("blocks promotion when %s Google login configuration is incomplete or wrong", async (environment) => {
    const names = ["ALGORITHM", "GOOGLE_LOGIN_CLIENT_ID", "GOOGLE_LOGIN_REDIRECT_URI", "GOOGLE_LOGIN_APP_ORIGINS", "GOOGLE_LOGIN_CLIENT_SECRET"]
    for (const name of names) {
      for (const failure of ["missing", "wrong-type", "empty", "wrong-value"] as const) {
        // Secret values cannot be read back. Their presence and type are checked.
        if (name === "GOOGLE_LOGIN_CLIENT_SECRET" && (failure === "empty" || failure === "wrong-value")) continue
        const version = identityVersion(environment)
        const binding = version.resources.bindings.find((entry) => entry.name === name)
        expect(binding, `${name} must be required by the manifest`).toBeDefined()
        if (failure === "missing") version.resources.bindings = version.resources.bindings.filter((entry) => entry.name !== name)
        else if (failure === "wrong-type") binding!.type = "json"
        else binding!.text = failure === "empty" ? "" : "incorrect-environment-value"
        const promoteVersion = vi.fn()
        await expect(runVerifiedDeployment({
          surface: "identity", environment, sourceId: "test-config",
          upload: vi.fn().mockResolvedValue(PRODUCTION_VERSION_ID),
          verifyVersion: async (surface, targetEnvironment, id) => {
            expect([surface, targetEnvironment, id]).toEqual(["identity", environment, PRODUCTION_VERSION_ID])
            return verifyWorkerVersion("identity", environment, PRODUCTION_VERSION_ID, {
              run: vi.fn().mockResolvedValue(JSON.stringify(version)), log: vi.fn(),
            })
          },
          promoteVersion,
          verifyDeployment: vi.fn(),
        })).rejects.toThrow(name)
        expect(promoteVersion).not.toHaveBeenCalled()
      }
    }
  })

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

  // Moving a secret into Secrets Store must not make the deploy gate refuse
  // the Worker: the SS_<NAME> binding supplies env.<NAME> at runtime.
  it("accepts a required secret supplied only by a Secrets Store binding", () => {
    const version = identityVersion("production", [
      { name: "SS_SECRET_KEY", type: "secrets_store_secret", store_id: "s", secret_name: "aquilla-production-SECRET_KEY" },
    ])
    version.resources.bindings = version.resources.bindings.filter(
      (binding) => binding.name !== "SECRET_KEY",
    )
    expect(validateWorkerVersion(version, deploymentExpectation("identity", "production"), PRODUCTION_VERSION_ID))
      .toBe(PRODUCTION_VERSION_ID)
  })

  it("rejects an SS_ binding of the wrong type for a required secret", () => {
    const version = identityVersion("production", [{ name: "SS_SECRET_KEY", type: "plain_text", text: "x" }])
    expect(() =>
      validateWorkerVersion(version, deploymentExpectation("identity", "production"), PRODUCTION_VERSION_ID),
    ).toThrow("SS_SECRET_KEY must be secrets_store_secret, received plain_text")
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
