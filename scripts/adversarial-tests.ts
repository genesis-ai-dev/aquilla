import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { loadEnvFile } from "node:process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertAdversarialTarget, targetEnv, targetUrls, type TargetKind } from "../smart-tests/adversarial/target"

/*
 * pnpm test:adversarial [--target local|dev|preview|prod-canary] [--attack <id>] [--mode <mode>]
 *   [--branch <name> --wait-for-sha <sha>]   (preview only)
 *   [--repeat-each N] [--workers N] [--no-report] [--loop] [--canary-only]
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const envFile = process.env.ADVERSARIAL_ENV_FILE ?? path.join(root, ".env.adversarial.local")
if (existsSync(envFile)) loadEnvFile(envFile)

const args = process.argv.slice(2).filter((arg) => arg !== "--")
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const kind = (flag("target") ?? process.env.ADVERSARIAL_TARGET ?? "local") as TargetKind
process.env.ADVERSARIAL_TARGET = kind
if (kind === "preview") process.env.ADVERSARIAL_PREVIEW_BRANCH = flag("branch") ?? process.env.ADVERSARIAL_PREVIEW_BRANCH ?? ""
if (kind !== "local") Object.assign(process.env, targetEnv(kind, process.env.ADVERSARIAL_PREVIEW_BRANCH))
if (args.includes("--no-report")) process.env.ADVERSARIAL_NO_REPORT = "1"
if (flag("workers")) process.env.ADVERSARIAL_WORKERS = flag("workers")
// The local stack's URLs exist only once e2e-up boots it; the config guards that case.
if (kind !== "local") assertAdversarialTarget(process.env)
// --canary-only runs the model-free health gate alone, to check a target and its accounts.
const canaryOnly = args.includes("--canary-only") || kind === "prod-canary"
if (!canaryOnly && (!process.env.TYPESAFE_API_KEY || !process.env.TEXT_MODEL_API_KEY)) {
  throw new Error("Attacks need TYPESAFE_API_KEY and TEXT_MODEL_API_KEY (see smart-tests/README.md)")
}
// An unset text-provider URL once sent the OpenRouter key to another provider (#716).
if (!canaryOnly && (!process.env.TYPESAFE_URL || !process.env.TEXT_MODEL_BASE_URL)) {
  throw new Error("Set TYPESAFE_URL and TEXT_MODEL_BASE_URL explicitly (see smart-tests/README.md)")
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const attack = flag("attack")
const mode = flag("mode")
// The canary always matches, so a filter can never skip the health gate.
const grep = canaryOnly ? "canary:" : attack || mode
  ? `canary:|adv ${mode ? escape(mode) : "\\S+"} ${attack ? escape(attack) : "\\S+"} #` : null
const playwrightArgs = [
  ...(grep ? ["--grep", grep] : []),
  ...(flag("repeat-each") ? ["--repeat-each", flag("repeat-each")!] : []),
]

function runOnce(): Promise<number> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-")
  const env = { ...process.env, ADVERSARIAL_RUN_ID: runId, SMART_TEST_RUN_ID: `adv-${runId}` }
  const command = kind === "local"
    // Reuse e2e-up's fourth isolated stack, as the cooperative suite does.
    ? ["exec", "tsx", "scripts/e2e-up.ts", "--", "--shard=1/1", ...playwrightArgs]
    : ["exec", "playwright", "test", "--config", "smart-tests/adversarial/config.ts", ...playwrightArgs]
  const child = spawn("pnpm", command, {
    cwd: root, stdio: "inherit",
    env: kind === "local" ? { ...env, E2E_SHARD: "4/4", E2E_CONFIG: "smart-tests/adversarial/config.ts" } : env,
  })
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopping = true; child.kill(signal) })
  return new Promise((resolve) => {
    child.on("error", () => resolve(1))
    child.on("exit", (code) => resolve(code ?? 1))
  })
}

/**
 * A preview alias serves the branch's latest successful build, which can lag
 * the PR head. Attacking an older build would report on the wrong code, so
 * wait for version.json to name the expected commit. Exit 3 means "not run".
 */
async function waitForPreview(sha: string): Promise<boolean> {
  const deadline = Date.now() + Number(process.env.ADVERSARIAL_PREVIEW_WAIT_MS ?? 25 * 60_000)
  const url = `${targetUrls(process.env).baseURL}/version.json`
  while (Date.now() < deadline) {
    const served = await fetch(url, { cache: "no-store" })
      .then(async (response) => response.ok ? (await response.json() as { sha?: string }).sha ?? "" : "")
      .catch(() => "")
    if (served && sha.startsWith(served)) return true
    console.log(`[adversarial] preview serves ${served || "nothing"}; waiting for ${sha.slice(0, 7)}`)
    await new Promise((resolve) => setTimeout(resolve, 20_000))
  }
  return false
}

const expectedSha = flag("wait-for-sha")
if (kind === "preview" && expectedSha && !await waitForPreview(expectedSha)) {
  console.error(`[adversarial] The preview never served ${expectedSha}; nothing was run.`)
  process.exit(3)
}

let stopping = false
let code = await runOnce()
// --loop reruns with a fresh run org each cycle; findings file as they happen.
while (args.includes("--loop") && !stopping) code = Math.max(code, await runOnce())
process.exitCode = code
