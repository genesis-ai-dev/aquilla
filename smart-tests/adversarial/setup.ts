import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resetBackend } from "../../e2e/helpers/seed"
import { adversarialUsers, assertAdversarialTarget, targetUrls } from "./target"
import { createRunOrg, deployedBuild, login, type RunContext } from "./state"

/**
 * Log in once per run and create the run org. Workers read the context from
 * a private temp file: it holds JWTs, so it never enters results/ or CI
 * artifacts.
 */
export default async function globalSetup(): Promise<void> {
  const kind = assertAdversarialTarget(process.env)
  if (kind === "local") await resetBackend()
  const sessions = []
  for (const user of adversarialUsers(process.env, kind)) sessions.push(await login(user))
  const runId = process.env.ADVERSARIAL_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-")
  const context: RunContext = {
    runId,
    kind,
    sessions,
    orgId: await createRunOrg(sessions[0], runId),
    deployedBuild: kind === "local" ? null : await deployedBuild(targetUrls(process.env).baseURL),
  }
  const file = path.join(mkdtempSync(path.join(tmpdir(), "aquilla-adv-")), "context.json")
  writeFileSync(file, JSON.stringify(context), { mode: 0o600 })
  process.env.ADVERSARIAL_CONTEXT = file
  process.env.ADVERSARIAL_RUN_ID = runId
}
