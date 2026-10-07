import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

/** The trusted controller attests the app and harness separately. */
export function buildIdentity(env = process.env) {
  if (env.SMART_TEST_APP_SHA || env.SMART_TEST_HARNESS_SHA) {
    if (![env.SMART_TEST_APP_SHA, env.SMART_TEST_HARNESS_SHA]
      .every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ""))) {
      throw new Error("External testing requires exact app and harness commits")
    }
    return { build: env.SMART_TEST_APP_SHA!, dirty: false,
      harnessBuild: env.SMART_TEST_HARNESS_SHA!, trackedDiffHash: null }
  }
  return {
    build: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    harnessBuild: null,
    trackedDiffHash: createHash("sha256").update(execFileSync("git", ["diff", "HEAD"])).digest("hex"),
  }
}
