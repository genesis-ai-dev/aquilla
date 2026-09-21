import { spawn } from "node:child_process"
import { loadEnvFile } from "node:process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
if (process.env.SMART_TEST_ENV_FILE) loadEnvFile(process.env.SMART_TEST_ENV_FILE)
const args = process.argv.slice(2).filter((arg) => arg !== "--")
const qualify = args.includes("--qualify")
const audit = args.includes("--audit")
if (!qualify && !audit && (!process.env.TYPESAFE_API_KEY || !process.env.TEXT_MODEL_API_KEY)) {
  throw new Error("Live smart tests require TYPESAFE_API_KEY and TEXT_MODEL_API_KEY; use --qualify for the offline-model oracle check")
}
// Reuse e2e-up's fourth isolated stack, outside the smoke suite's three
// stacks. Explicit --shard=1/1 runs ALL smart tests on this stack.
const child = spawn("pnpm", [
  "exec", "tsx", "scripts/e2e-up.ts", "--", "--shard=1/1",
  ...(qualify ? ["qualification.spec.ts"] : audit ? ["dom-audit.spec.ts"] : []),
  ...args.filter((arg) => arg !== "--qualify" && arg !== "--audit"),
], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    E2E_SHARD: "4/4",
    E2E_CONFIG: "smart-tests/config.ts",
    SMART_TEST_RUN_ID: process.env.SMART_TEST_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-"),
  },
})
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal))
}
child.on("error", () => { process.exitCode = 1 })
child.on("exit", (code) => { process.exitCode = code ?? 1 })
