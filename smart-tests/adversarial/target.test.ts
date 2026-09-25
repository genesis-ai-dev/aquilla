import { describe, expect, it } from "vitest"
import { adversarialUsers, assertAdversarialTarget, attacksAllowed, previewAlias, previewUrls, targetEnv } from "./target"
import { workersBuildPreviewAlias } from "../../scripts/cloudflare-pr-preview.mjs"

const local = {
  ADVERSARIAL_TARGET: "local", E2E_BASE_URL: "http://127.0.0.1:6473", VITE_FRONTIER_BASE: "http://127.0.0.1:10087",
  VITE_SYNC_WORKER_HOST: "127.0.0.1:10088", E2E_DATABASE_URL: "postgres://u@127.0.0.1:5432/aquilla_e2e_s3",
}

describe("adversarial target guard", () => {
  it("accepts the owned local stack and the exact dev hosts", () => {
    expect(assertAdversarialTarget(local)).toBe("local")
    expect(assertAdversarialTarget({ ADVERSARIAL_TARGET: "dev", ...targetEnv("dev") })).toBe("dev")
  })

  it("refuses production hosts under the dev label, so a typo cannot attack prod", () => {
    expect(() => assertAdversarialTarget({ ...targetEnv("prod-canary"), ADVERSARIAL_TARGET: "dev" })).toThrow()
  })

  it("refuses a shared or remote database on the local target", () => {
    expect(() => assertAdversarialTarget({ ...local, E2E_DATABASE_URL: "postgres://u@db.neon.tech/aquilla" })).toThrow()
  })

  it("refuses staging and unknown targets", () => {
    expect(() => assertAdversarialTarget({ ADVERSARIAL_TARGET: "staging" })).toThrow()
    expect(() => assertAdversarialTarget({ ADVERSARIAL_TARGET: "dev", E2E_BASE_URL: "https://staging.aquilla.app" })).toThrow()
  })

  it("derives the same preview alias as the deploy script, so a PR run attacks its own preview", () => {
    for (const branch of ["ryder/jev-adversarial-suite", "dev", "AQU-1338 Weird__Name//x", "a".repeat(80)]) {
      expect(previewAlias(branch)).toBe(workersBuildPreviewAlias(branch))
    }
  })

  it("accepts a branch preview only with that branch's exact hosts", () => {
    const env = { ADVERSARIAL_TARGET: "preview", ADVERSARIAL_PREVIEW_BRANCH: "feature/x", ...targetEnv("preview", "feature/x") }
    expect(assertAdversarialTarget(env)).toBe("preview")
    expect(previewUrls("feature/x").identityBase).toMatch(/^https:\/\/ci-feature-x-[0-9a-f]{8}-aquilla-auth-preview\.blue-darkness-7674\.workers\.dev\/identity$/)
    expect(() => assertAdversarialTarget({ ...env, ADVERSARIAL_PREVIEW_BRANCH: "feature/y" })).toThrow()
  })

  it("never allows attacks on production, only the canary", () => {
    expect(attacksAllowed("prod-canary")).toBe(false)
    expect(attacksAllowed("dev")).toBe(true)
  })

  it("requires explicit credentials off the local stack", () => {
    expect(() => adversarialUsers({}, "dev")).toThrow(/ADVERSARIAL_USER_1/)
    expect(adversarialUsers({}, "local")[0].username).toBe("alice")
    expect(adversarialUsers({ ADVERSARIAL_USER_1: "a:p:w", ADVERSARIAL_USER_2: "b:x", ADVERSARIAL_USER_3: "c:y" }, "dev")[0])
      .toEqual({ username: "a", password: "p:w" })
  })
})
